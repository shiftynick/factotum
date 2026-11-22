// dev.106: the scan of the operator's Codex skill folders matches Codex's own skill discovery
// (docs/changes/dev106-codex-skill-discovery.md). Fictional fixtures and a scripted transport only:
// no provider CLI or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createProviderAdapter, assertWorktreeIsolation, WORKTREE_ISOLATION, codexOperatorSkills, codexSkillRules, operatorSkillFolders, CODEX_SKILL_DISCOVERY, CODEX_SKILL_WALK_LIMITS } from '../starter/factory/adapters/providers/index.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { doctor } from '../starter/factory/workflows/commission.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';

const HELP = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config';
const session = '00000000-0000-0000-0000-000000000001';
const events = [{ type: 'thread.started', thread_id: session }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'implemented', summary: 'Done' }) } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }];
const scratch = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dev106-'))); t.after(() => { try { chmodSync(join(dir, 'home/.codex/skills/locked'), 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); }); return dir; };
const skill = (dir, name = 'fictional') => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Fictional skill\n---\nFictional.\n`); return join(dir, 'SKILL.md'); };
const nest = (base, parts) => join(base, ...parts);
function fixture(t) {
  const dir = scratch(t), repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(repo); execFileSync('git', ['init', '-q'], { cwd: repo });
  return { dir, repo, home, codexSkills: join(home, '.codex/skills'), agentSkills: join(home, '.agents/skills'), environment: { HOME: home, PATH: '/bin' } };
}
// Starts the adapter with a scripted transport: --version reports `version`; the model call is recorded, never made.
async function invoke(f, version, spec = {}) {
  const calls = [];
  const transport = async (binary, args, opts) => {
    calls.push(args);
    if (args.includes('--version')) return { code: 0, stdout: version, stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: HELP, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
    return { code: 0, stdout: events.map(e => JSON.stringify(e)).join('\n'), stderr: '' };
  };
  const adapter = createProviderAdapter({ transport, environment: f.environment });
  const run = adapter.invoke({ provider: 'codex', model: 'fictional', role: 'builder', prompt: 'Fictional', timeoutMs: 60000, ...spec, cwd: f.repo, artifactDir: join(f.dir, `artifacts-${calls.length}-${Math.random().toString(36).slice(2)}`) });
  return { run, calls, modelCalls: () => calls.filter(args => args.includes('--output-schema')) };
}
const disabledSkills = args => [...args.find((arg, i) => args[i - 1] === '-c' && arg.startsWith('skills.config=')).matchAll(/\{path="([^"]*)",enabled=false\}/g)].map(match => match[1]);
async function disabledFor(f, version = 'codex-cli 0.171.0') {
  const a = await invoke(f, version); await a.run;
  assert.equal(a.modelCalls().length, 1, 'Codex is started');
  return disabledSkills(a.modelCalls()[0]);
}
const refusedFor = async (f, pattern, version = 'codex-cli 0.171.0') => {
  const a = await invoke(f, version);
  await assert.rejects(a.run, error => error.code === 'PROVIDER_REJECTED' && !error.started && pattern.test(error.message));
  assert.equal(a.modelCalls().length, 0, 'Codex is not started');
};

// Codex's skill discovery for one of the operator's skill folders, transcribed from its source at
// rust-v0.171.0 (identical from rust-v0.163.0): exec-server/src/local_file_system.rs sync_walk
// (breadth first, names sorted, folder links followed, a visited folder skipped, hidden folders not
// entered, at most `directories` folders queued and `entries` entries looked at, broken links
// omitted, links to files skipped) and ext/skills/src/loader/discovery.rs (a file named exactly
// SKILL.md), from the folder's real path (loader/host.rs). Returns the real path of each skill.
function codexFinds(root, { depth: maxDepth = 6, directories: maxDirectories = 2000, entries: maxEntries = 20000 } = {}) {
  let start; try { start = realpathSync(root); if (!statSync(start).isDirectory()) return []; } catch { return []; }
  const found = [], queue = [[start, 0]], visited = new Set([start]);
  let directories = 1, entries = 0;
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let names; try { names = readdirSync(dir); } catch { continue; }
    names = names.filter(name => { const path = join(dir, name); try { if (lstatSync(path).isSymbolicLink()) statSync(path); return true; } catch { return false; } });
    names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      if (entries === maxEntries) return found;
      entries++;
      const path = join(dir, name); let link, meta;
      try { link = lstatSync(path).isSymbolicLink(); meta = statSync(path); } catch { continue; }
      if (link && !meta.isDirectory()) continue;
      if (meta.isFile()) { if (name === 'SKILL.md') found.push(realpathSync(path)); continue; }
      if (!meta.isDirectory() || depth >= maxDepth || name.startsWith('.')) continue;
      const identity = realpathSync(path);
      if (visited.has(identity)) continue; visited.add(identity);
      if (directories !== maxDirectories) { directories++; queue.push([path, depth + 1]); }
    }
  }
  return found;
}
const assertCovers = (f, disabled) => { for (const root of [f.codexSkills, f.agentSkills]) for (const path of codexFinds(root)) assert.ok(disabled.includes(path), `${path} is loadable by Codex but not disabled`); };

test('the rules are chosen by the Codex version: checked releases use Codex\'s own discovery, any other the conservative scan', () => {
  assert.deepEqual(codexSkillRules('codex-cli 0.171.0'), { version: '0.171.0', reported: 'codex-cli 0.171.0', rules: 'codex' });
  assert.equal(codexSkillRules('codex-cli 0.163.0').rules, 'codex');
  for (const version of ['codex-cli 0.172.0', 'codex-cli 0.162.0', 'fictional', '', undefined]) assert.equal(codexSkillRules(version).rules, 'conservative', String(version));
  // Review fix: only the exact one-line output of a checked stable release counts. A prerelease, a
  // custom build, any other suffix or prefix, and a wrapper's banner with the version on another
  // line all get the conservative scan.
  assert.equal(codexSkillRules('codex-cli 0.171.0\n').rules, 'codex');
  for (const version of ['codex-cli 0.171.0-alpha.1', 'codex-cli 0.171.0-custom', 'codex-cli 0.171.0.1', 'codex-cli 0.171.0 (fictional build)', 'codex 0.171.0', 'fictional-codex-cli 0.171.0', 'codex-cli  0.171.0',
    'wrapper 0.171.0\ncodex-cli 0.172.0', 'Fictional wrapper banner\ncodex-cli 0.171.0', 'codex-cli 0.171.0\ncodex-cli 0.172.0']) assert.equal(codexSkillRules(version).rules, 'conservative', version);
  assert.equal(CODEX_SKILL_DISCOVERY.depth, 6); assert.equal(CODEX_SKILL_DISCOVERY.directoriesPerRoot, 2000); assert.equal(CODEX_SKILL_DISCOVERY.entriesPerRoot, 20000);
  // Codex reads HOME, and the account's home folder when HOME is unset or empty; an empty CODEX_HOME is unset.
  assert.deepEqual(operatorSkillFolders({ HOME: '/fictional', CODEX_HOME: '' }), ['/fictional/.codex/skills', '/fictional/.agents/skills', '/etc/codex/skills']);
  assert.deepEqual(operatorSkillFolders({ HOME: '/fictional', CODEX_HOME: '/elsewhere' }), ['/elsewhere/skills', '/fictional/.agents/skills', '/etc/codex/skills']);
  assert.deepEqual(operatorSkillFolders({}).slice(0, 2), [join(userInfo().homedir, '.codex/skills'), join(userInfo().homedir, '.agents/skills')]);
});

// The third adopter's report: a skill linked into $CODEX_HOME/skills with a bundled dependency tree
// in scripts/node_modules, far deeper than 8 levels, refused every Codex step.
function reportedLayout(f) {
  const elsewhere = join(f.dir, 'elsewhere/ui-craft');
  skill(elsewhere, 'ui-craft');
  const modules = join(elsewhere, 'scripts/node_modules');
  for (let p = 0; p < 40; p++) { const leaf = nest(modules, [`p${p}`, 'lib', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); mkdirSync(leaf, { recursive: true }); writeFileSync(join(leaf, 'index.js'), ''); }
  mkdirSync(nest(modules, ['.bin', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), { recursive: true });
  // skills(0)/ui-craft(1)/scripts(2)/node_modules(3)/@scope(4)/kit(5): within Codex's depth.
  const reachable = skill(join(modules, '@scope/kit'), 'kit');
  // node_modules(3)/p0(4)/lib(5)/a(6)/b(7): Codex reads no folder at depth 7.
  const tooDeep = skill(nest(modules, ['p0', 'lib', 'a', 'b']), 'too-deep');
  mkdirSync(f.codexSkills, { recursive: true }); symlinkSync(elsewhere, join(f.codexSkills, 'ui-craft'));
  return { elsewhere, reachable, tooDeep };
}
test('the reported layout: a linked skill with a deep scripts/node_modules tree starts Codex with that skill disabled', async t => {
  const f = fixture(t), r = reportedLayout(f);
  for (const version of ['codex-cli 0.171.0', 'codex-cli 0.169.0', 'codex-cli 0.163.0']) {
    const disabled = await disabledFor(f, version);
    assert.ok(disabled.includes(join(f.codexSkills, 'ui-craft/SKILL.md')), 'by the link\'s spelling');
    assert.ok(disabled.includes(join(r.elsewhere, 'SKILL.md')), 'by its real path');
    assert.ok(disabled.includes(r.reachable), 'a SKILL.md inside node_modules that Codex reaches');
    assert.ok(!disabled.includes(r.tooDeep), 'nothing below depth 6 is read');
    assertCovers(f, disabled);
  }
  // A Codex version whose discovery has not been checked keeps the conservative scan: refused, saying
  // why. So does a prerelease or custom build of a checked version, and a wrapper's banner (review fix).
  await refusedFor(f, /Codex "codex-cli 0\.171\.0-alpha\.1" is not a version whose skill discovery the factory has checked/, 'codex-cli 0.171.0-alpha.1');
  await refusedFor(f, /Codex "wrapper 0\.171\.0" is not a version whose skill discovery the factory has checked/, 'wrapper 0.171.0\ncodex-cli 0.172.0');
  await refusedFor(f, /Codex 0\.172\.0 is not a version whose skill discovery the factory has checked \(0\.163\.0 to 0\.171\.0\), so it scans the operator's skill folders conservatively: a skill folder deeper than 8 levels/, 'codex-cli 0.172.0');
});

// Review fix: Codex loads skills from plugins too, outside the operator's skill folders (configured in
// any layer, an administrator's /etc/codex/config.toml included, or remote-installed). The plugins
// feature off (--disable plugins) loads no plugin, so no plugin skill root, on every Codex call.
test('every Codex call, fresh and resumed, read-only and builder, turns plugins off; a call without it is refused', async t => {
  const f = fixture(t);
  for (const spec of [{}, { sessionId: session }, { role: 'planner' }, { role: 'reviewer' }]) {
    // The scripted result fits only the builder's schema; the call's arguments are what is checked.
    const a = await invoke(f, 'codex-cli 0.171.0', spec); await a.run.catch(() => {});
    assert.equal(a.modelCalls().length, 1, JSON.stringify(spec));
    const args = a.modelCalls().at(-1);
    assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === 'plugins'), `${JSON.stringify(spec)}: ${args.join(' ')}`);
  }
  assert.ok(WORKTREE_ISOLATION.codex.some((arg, i) => arg === '--disable' && WORKTREE_ISOLATION.codex[i + 1] === 'plugins'));
  const without = ['exec', ...WORKTREE_ISOLATION.codex.filter((arg, i, all) => !(arg === '--disable' && all[i + 1] === 'plugins') && !(arg === 'plugins' && all[i - 1] === '--disable')), '-c', 'sandbox_workspace_write.writable_roots=["/w"]', '-c', 'projects={}', '-c', 'skills.config=[]'];
  assert.throws(() => assertWorktreeIsolation('codex', without, { workingRoot: '/r', worktree: '/w' }), error => error.code === 'PROVIDER_REJECTED');
  assert.doesNotThrow(() => assertWorktreeIsolation('codex', ['exec', ...WORKTREE_ISOLATION.codex, '-c', 'sandbox_workspace_write.writable_roots=["/w"]', '-c', 'projects={}', '-c', 'skills.config=[]'], { workingRoot: '/r', worktree: '/w' }));
});

test('every SKILL.md Codex would load is disabled: nested in a skill, at depth 6, through links, in each skill folder', async t => {
  const f = fixture(t);
  const outer = skill(join(f.codexSkills, 'outer'), 'outer'), inner = skill(join(f.codexSkills, 'outer/references/inner'), 'inner');
  const atSix = skill(nest(f.codexSkills, ['a', 'b', 'c', 'd', 'e', 'f']), 'at-six');
  const atSeven = skill(nest(f.codexSkills, ['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'at-seven');
  // The same folder is reached at depth 1 through a link: g/SKILL.md is at depth 2 there, so Codex
  // loads it (each folder is read at the shallowest depth it is reached).
  symlinkSync(nest(f.codexSkills, ['a', 'b', 'c', 'd', 'e', 'f']), join(f.codexSkills, 'shortcut'));
  // Each skill folder is its own walk: a folder seen too deep in one is read again in another.
  const deepInCodexHome = skill(nest(f.codexSkills, ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']), 'cross');
  mkdirSync(f.agentSkills, { recursive: true }); symlinkSync(nest(f.codexSkills, ['x1', 'x2', 'x3', 'x4', 'x5', 'x6']), join(f.agentSkills, 'via-home'));
  // What Codex skips the factory may skip: a hidden folder.
  const hidden = skill(join(f.codexSkills, '.cache/hidden'), 'hidden');
  const disabled = await disabledFor(f);
  for (const path of [outer, inner, atSix, atSeven, deepInCodexHome]) assert.ok(disabled.includes(path), path);
  assert.ok(disabled.includes(join(f.codexSkills, 'shortcut/g/SKILL.md')));
  assert.ok(disabled.includes(join(f.agentSkills, 'via-home/x7/x8/SKILL.md')));
  assert.ok(!disabled.includes(hidden));
  assertCovers(f, disabled);
  assert.ok(codexFinds(f.codexSkills).includes(atSeven) && codexFinds(f.agentSkills).includes(deepInCodexHome), 'the fixture reaches them only through the links');
});

test("Codex's own caps: the factory reads whole levels up to them and stops where Codex stops", async t => {
  // 2,000 folders queued (the skill folder included): Codex queues no folder of the next level.
  const f = fixture(t);
  for (let i = 0; i < 2000; i++) mkdirSync(join(f.codexSkills, `d${String(i).padStart(4, '0')}`), { recursive: true });
  const lastRead = skill(join(f.codexSkills, 'd1999'), 'last'), unqueued = skill(join(f.codexSkills, 'd0000/below'), 'below');
  let disabled = await disabledFor(f);
  assert.ok(disabled.includes(lastRead), 'the whole level is read, past the folder where Codex stopped');
  assert.ok(!disabled.includes(unqueued), 'Codex queued nothing below that level');
  assertCovers(f, disabled);
  // Below the cap, the next level is read.
  rmSync(f.codexSkills, { recursive: true });
  const shallow = skill(join(f.codexSkills, 'd0000/below'), 'below');
  disabled = await disabledFor(f); assert.ok(disabled.includes(shallow));
  // 20,000 entries looked at: Codex reads no entry of the next level.
  rmSync(f.codexSkills, { recursive: true });
  const crowded = join(f.codexSkills, 'a-crowded'); mkdirSync(crowded, { recursive: true });
  for (let i = 0; i < 20000; i++) writeFileSync(join(crowded, `f${i}`), '');
  const sameLevel = skill(join(f.codexSkills, 'b'), 'same-level'), nextLevel = skill(join(f.codexSkills, 'b/c'), 'next-level');
  disabled = await disabledFor(f);
  assert.ok(disabled.includes(sameLevel), 'its level is read whole');
  assert.ok(!disabled.includes(nextLevel), 'Codex reads nothing past 20,000 entries');
  assertCovers(f, disabled);
});

test("the factory's own bounds still refuse when they apply", async t => {
  const f = fixture(t);
  // More entries to read than the factory's bound, in one level Codex may read: ten folders of 10,001
  // entries each at depth 1, where Codex has counted only ten entries before them.
  for (let d = 0; d < 10; d++) { const wide = join(f.codexSkills, `w${d}`); mkdirSync(wide, { recursive: true }); for (let i = 0; i <= CODEX_SKILL_WALK_LIMITS.entries / 10; i++) writeFileSync(join(wide, `f${i}`), ''); }
  await refusedFor(f, new RegExp(`more than ${CODEX_SKILL_WALK_LIMITS.entries} entries to read in the skill folder ${f.codexSkills.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} within Codex's discovery bounds`));
  for (let d = 0; d < 10; d++) rmSync(join(f.codexSkills, `w${d}`), { recursive: true });
  // More distinct skills than the bound.
  for (let i = 0; i <= CODEX_SKILL_WALK_LIMITS.skills; i++) skill(join(f.codexSkills, `s${i}`), `s${i}`);
  await refusedFor(f, /more than 256 skills in the operator's skill folders/);
  for (let i = 0; i <= CODEX_SKILL_WALK_LIMITS.skills; i++) rmSync(join(f.codexSkills, `s${i}`), { recursive: true });
  // A folder Codex would read that cannot be listed (skipped as root, which can list it anyway).
  if (process.getuid?.() !== 0) {
    const locked = join(f.codexSkills, 'locked'); mkdirSync(locked); chmodSync(locked, 0o000);
    try { await refusedFor(f, /the skill folder .*locked cannot be listed \(EACCES\)/); } finally { chmodSync(locked, 0o700); }
    // Below Codex's depth the same folder is never read, so it refuses nothing.
    rmSync(locked, { recursive: true });
    const deepLocked = nest(f.codexSkills, ['a', 'b', 'c', 'd', 'e', 'f', 'locked']); mkdirSync(deepLocked, { recursive: true }); chmodSync(deepLocked, 0o000);
    try { await disabledFor(f); } finally { chmodSync(deepLocked, 0o700); }
  }
});

// ---- Doctor ----
function doctorFixture(t, planner = 'codex') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev106-doctor-'))), root = join(base, 'repo'), remote = join(base, 'remote.git'), stateDir = join(base, 'state');
  mkdirSync(root); const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fictional@example.invalid']); git(['config', 'user.name', 'Fictional']); writeFileSync(join(root, 'fixture.txt'), 'fictional'); git(['add', '.']); git(['commit', '-qm', 'Fictional baseline']); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  initProject({ stateDir, root, name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const store = new Store(stateDir), config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: planner, model: 'fictional' }, builder: { provider: 'claude', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: [{ id: 'main', argv: [process.execPath, '-e', "require('node:fs').readFileSync('fixture.txt')"], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(base, 'host.sqlite') }, backupRoot: join(base, 'backups') };
  store.setMeta('config', config); store.setMeta('configDigest', digest(config));
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  return { stateDir, base };
}
const providersAt = version => ({ providerPreflight: async spec => ({ provider: spec.provider, version: spec.provider === 'codex' ? version : '2.1.325', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) });
test('doctor warns ahead of time when an operator skill folder would refuse every Codex step, naming the folder and the remedy', async t => {
  const d = doctorFixture(t), f = { dir: d.base, home: join(d.base, 'home') }; f.codexSkills = join(f.home, '.codex/skills');
  const checked = [];
  // The real scan, on the fixture's home rather than this host's.
  const skillFolderCheck = options => { checked.push(options.version); return codexOperatorSkills({ ...options, environment: { HOME: f.home } }); };
  reportedLayout(f);
  // Under Codex 0.171.0's rules the reported layout is fine: no warning.
  let result = await doctor(d.stateDir, { ...providersAt('codex-cli 0.171.0'), skillFolderCheck });
  assert.equal(result.ready, true, JSON.stringify(result.reasons));
  assert.deepEqual(checked, ['codex-cli 0.171.0']);
  assert.ok(!result.warnings.some(text => /skill/.test(text)), JSON.stringify(result.warnings));
  // An unchecked Codex version: the conservative scan refuses, and doctor says so, with the remedy.
  result = await doctor(d.stateDir, { ...providersAt('codex-cli 0.172.0'), skillFolderCheck });
  assert.equal(result.ready, true, 'a warning, never a reason');
  let warning = result.warnings.find(text => /Every Codex step on this host will be refused before it starts/.test(text));
  assert.ok(warning, JSON.stringify(result.warnings));
  assert.match(warning, /Codex 0\.172\.0 is not a version whose skill discovery the factory has checked/);
  assert.ok(warning.includes(join(f.codexSkills, 'ui-craft')), 'names the folder');
  assert.match(warning, /Install a Codex version whose skill discovery the factory has checked \(0\.163\.0 to 0\.171\.0\), or remove the cause from the folder named/);
  // A bound that applies under Codex's own rules too.
  for (let i = 0; i <= CODEX_SKILL_WALK_LIMITS.skills; i++) skill(join(f.codexSkills, `many/s${i}`), `s${i}`);
  result = await doctor(d.stateDir, { ...providersAt('codex-cli 0.171.0'), skillFolderCheck });
  warning = result.warnings.find(text => /Every Codex step on this host will be refused before it starts/.test(text));
  assert.ok(warning, JSON.stringify(result.warnings));
  assert.match(warning, /more than 256 skills in the operator's skill folders/);
  assert.match(warning, /move a large dependency tree \(such as a skill's node_modules\) out of the operator's skill folders, remove the extra skills, or make the folder readable/);
  // No Codex route, no check.
  checked.length = 0;
  await doctor(doctorFixture(t, 'claude').stateDir, { ...providersAt('codex-cli 0.171.0'), skillFolderCheck });
  assert.deepEqual(checked, []);
});
