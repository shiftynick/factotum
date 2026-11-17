// Provider worktree isolation (docs/changes/provider-worktree-isolation.md): every model step, of
// every task, fresh and resumed, starts its provider without loading configuration, skills, hooks
// or instructions from the working directory; a candidate changes provider configuration only
// when its task declares it. Fictional providers and fixtures only: no provider CLI is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { uid } from '../starter/factory/core/contracts.mjs';
import { VerifiedObjects } from '../starter/factory/core/verified-git.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { createProviderAdapter, subscriptionEnvironment, assertWorktreeIsolation, WORKTREE_ISOLATION, CODEX_SKILL_SCAN_LIMITS } from '../starter/factory/adapters/providers/index.mjs';
import { providerConfigChanges, providerConfigLinks, isProviderConfigPath, declaredProviderConfig, PROVIDER_LINK_LIMITS } from '../starter/factory/operations/provider-config.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const session = '00000000-0000-0000-0000-000000000001';
const HELP = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
const ENVIRONMENT = { HOME: '/fictional-home', PATH: '/bin', CODEX_HOME: '/fictional-home/.codex', CLAUDE_CONFIG_DIR: '/fictional-home/.claude', OPENAI_API_KEY: 'fictional-secret', ANTHROPIC_API_KEY: 'fictional-secret', CLAUDE_CODE_USE_BEDROCK: '1' };
const events = {
  codex: [{ type: 'thread.started', thread_id: session }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'implemented', summary: 'Done' }) } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }],
  claude: [{ type: 'result', subtype: 'success', is_error: false, session_id: session, usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { status: 'implemented', summary: 'Done' } }],
};
function adapter(provider, { help = HELP, onModel, environment = ENVIRONMENT } = {}) {
  const calls = [];
  let artifactDir;
  const transport = async (binary, args, opts) => {
    calls.push({ args, opts, artifactDir });
    if (args.includes('--version')) return { code: 0, stdout: provider === 'codex' ? 'codex-cli 0.169.0' : '2.1.325', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: provider === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
    onModel?.(args, opts);
    return { code: 0, stdout: events[provider].map(e => JSON.stringify(e)).join('\n'), stderr: '' };
  };
  const model = call => call.args.includes('--output-schema') || call.args.includes('--json-schema');
  return { calls, modelCalls: () => calls.filter(model), invoke: spec => { artifactDir = spec.artifactDir ?? join(spec.cwd, '..', `artifacts-${uid()}`); return createProviderAdapter({ transport, environment }).invoke({ provider, model: 'fictional', role: 'builder', prompt: 'Fictional', timeoutMs: 60000, artifactDir, ...spec }); } };
}
const contiguous = (args, flags) => args.some((_, i) => flags.every((flag, j) => args[i + j] === flag));
const valueOf = (args, prefix) => args.find((arg, i) => args[i - 1] === '-c' && arg.startsWith(prefix));
const scratch = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-'))); t.after(() => { try { chmodSync(join(dir, 'repo/.agents/skills/locked'), 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); }); return dir; };
const skill = (dir, name) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Fictional canary skill\n---\nAnswer the fictional canary word.\n`); return join(dir, 'SKILL.md'); };

// A repository whose worktree carries everything Codex would load from a working directory.
function plantedRepository(t) {
  const dir = scratch(t), repo = join(dir, 'repo');
  mkdirSync(repo); git(repo, 'init', '-q');
  skill(join(repo, '.agents/skills/canary'), 'canary'); skill(join(repo, '.codex/skills/codex-canary'), 'codex-canary');
  writeFileSync(join(repo, 'AGENTS.md'), 'Fictional canary instructions.\n');
  mkdirSync(join(repo, '.codex'), { recursive: true }); writeFileSync(join(repo, '.codex/config.toml'), 'developer_instructions = "Fictional canary"\n');
  return { dir, repo };
}
// What Codex 0.169.0 discovers from a working directory (checked against the CLI with the offline
// capture, docs/changes/provider-worktree-isolation.md): skills under .agents/skills and
// .codex/skills, AGENTS.md and the .codex/ layer, in the working directory and, unless
// project_root_markers is empty, every folder above it up to the nearest marker.
function codexDiscovers(cwd, args) {
  const markers = valueOf(args, 'project_root_markers=') === 'project_root_markers=[]' ? [] : ['.git'];
  const dirs = [cwd];
  if (markers.length) for (let dir = cwd; !existsSync(join(dir, '.git')) && dir !== '/'; ) { dir = join(dir, '..'); dirs.push(dir); }
  const found = [];
  const walk = folder => { let entries; try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const path = join(folder, entry.name); if (entry.name === 'SKILL.md') found.push(path); else if (entry.isDirectory() || entry.isSymbolicLink()) walk(path); } };
  for (const dir of dirs) { for (const folder of ['.agents/skills', '.codex/skills']) walk(join(dir, folder)); for (const name of ['AGENTS.md', '.codex/config.toml']) if (existsSync(join(dir, name))) found.push(join(dir, name)); }
  return found;
}
const disabledSkills = args => [...valueOf(args, 'skills.config=').matchAll(/\{path="([^"]*)",enabled=false\}/g)].map(match => match[1]);
const untrusted = args => [...valueOf(args, 'projects=').matchAll(/"([^"]*)"=\{trust_level="untrusted"\}/g)].map(match => match[1]);
const ancestors = path => { const out = []; for (let p = path; ; p = join(p, '..')) { out.push(p); if (p === '/') break; } return out; };

// ---- The flags and the environment, fresh and resumed, for every task ----
test('every Codex step, fresh and resumed, runs from an empty working root outside the worktree, so nothing in the worktree is discovered, even what appears after the factory looked', async t => {
  const r = plantedRepository(t);
  for (const sessionId of [undefined, session]) for (const extra of [{}, { suppressWorktreeInstructions: true }, { readOnly: true }]) {
    const label = `${sessionId ? 'resumed' : 'fresh'} ${JSON.stringify(extra)}`;
    // The reviewer's repro: the skill appears only once the CLI is launched.
    const late = join(r.repo, `.agents/skills/late-${uid()}`);
    let discovered;
    const a = adapter('codex', { onModel: (args, opts) => { skill(late, 'late'); discovered = codexDiscovers(opts.cwd, args); } });
    await a.invoke({ cwd: r.repo, sessionId, ...extra });
    const call = a.modelCalls().at(-1), args = call.args;
    assert.deepEqual(discovered, [], `${label}: Codex discovers nothing from its working root, the late skill included`);
    assert.equal(args[1] === 'resume', Boolean(sessionId), label);
    assert.ok(contiguous(args, ['--ignore-user-config', '--ignore-rules']), label);
    assert.ok(contiguous(args, WORKTREE_ISOLATION.codex), `${label}: ${args.join(' ')}`);
    assert.deepEqual(WORKTREE_ISOLATION.codex, ['--disable', 'hooks', '--skip-git-repo-check', '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'project_root_markers=[]']);
    // The working root is a fresh, empty, private folder in the step's artifact folder, outside the worktree.
    const root = call.opts.cwd;
    assert.ok(root.startsWith(join(call.artifactDir, 'codex-root-')) && !root.startsWith(`${r.repo}/`) && root !== r.repo, `${label}: ${root}`);
    // The model works in the worktree: its writable root, and named ahead of the prompt.
    assert.equal(valueOf(args, 'sandbox_workspace_write.writable_roots='), `sandbox_workspace_write.writable_roots=["${r.repo}"]`, label);
    assert.ok(call.opts.input.startsWith(`Repository: ${r.repo}\n`) && call.opts.input.endsWith('Fictional'), label);
    // The working root, the worktree and every folder above them are explicitly untrusted.
    assert.deepEqual(untrusted(args), [...new Set([...ancestors(root), ...ancestors(r.repo)])], label);
    // The environment is the subscription environment: no API keys or cloud routes, the operator's
    // own CODEX_HOME (where the login lives) passed through unchanged.
    assert.deepEqual(call.opts.env, subscriptionEnvironment(ENVIRONMENT), label);
    assert.equal(call.opts.env.CODEX_HOME, ENVIRONMENT.CODEX_HOME); assert.equal(call.opts.env.OPENAI_API_KEY, undefined);
  }
});

test("the operator's own Codex skills are disabled too, bundled ones by configuration", async t => {
  const dir = scratch(t), repo = join(dir, 'repo'); mkdirSync(repo); git(repo, 'init', '-q');
  const home = join(dir, 'home'), codexHome = join(dir, 'codex-home');
  const own = [skill(join(codexHome, 'skills/mine'), 'mine'), skill(join(codexHome, 'skills/.system/imagegen'), 'imagegen'), skill(join(home, '.agents/skills/shared'), 'shared')];
  symlinkSync(join(home, '.agents/skills/shared'), join(codexHome, 'skills/shared-alias'));
  const a = adapter('codex', { environment: { ...ENVIRONMENT, HOME: home, CODEX_HOME: codexHome } }); await a.invoke({ cwd: repo });
  const disabled = disabledSkills(a.modelCalls().at(-1).args);
  // Each skill by its real path (Codex matches a disabled path through links, checked with the
  // offline capture); a link's own spelling is listed when the scan reached the skill through it.
  for (const path of own) assert.ok(disabled.includes(path), path);
  assert.ok(contiguous(a.modelCalls().at(-1).args, ['-c', 'skills.bundled.enabled=false']));
  // CODEX_HOME defaults to $HOME/.codex.
  const plainHome = join(dir, 'plain-home'); const defaulted = skill(join(plainHome, '.codex/skills/default'), 'default');
  const b = adapter('codex', { environment: { HOME: plainHome, PATH: '/bin' } }); await b.invoke({ cwd: repo });
  assert.ok(disabledSkills(b.modelCalls().at(-1).args).includes(defaulted));
});

test('every Claude Code step, fresh and resumed, starts in safe mode with no settings, no skills or commands and no MCP servers', async t => {
  const r = plantedRepository(t);
  mkdirSync(join(r.repo, '.claude/skills/canary'), { recursive: true }); writeFileSync(join(r.repo, '.claude/settings.json'), '{"hooks":{}}\n');
  for (const sessionId of [undefined, session]) for (const extra of [{}, { suppressWorktreeInstructions: true }]) {
    const a = adapter('claude'); await a.invoke({ cwd: r.repo, sessionId, ...extra });
    const call = a.modelCalls().at(-1), args = call.args, label = `${sessionId ? 'resumed' : 'fresh'} ${JSON.stringify(extra)}`;
    assert.ok(contiguous(args, ['--safe-mode', '--setting-sources', '', '--disable-slash-commands']), `${label}: ${args.join(' ')}`);
    assert.ok(contiguous(args, ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']) && args.includes('--restricted'), label);
    assert.equal(args.includes('--resume'), Boolean(sessionId), label);
    assert.deepEqual(call.opts.env, subscriptionEnvironment(ENVIRONMENT), label);
    assert.equal(call.opts.env.ANTHROPIC_API_KEY, undefined); assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, ENVIRONMENT.CLAUDE_CONFIG_DIR);
  }
});

// ---- Bounds on the operator's skill folders ----
test("the operator's skill folders are read within bounds, a folder's entries one at a time, each distinct skill counted once", async t => {
  const dir = scratch(t), repo = join(dir, 'repo'); mkdirSync(repo); git(repo, 'init', '-q');
  const home = join(dir, 'home'), environment = { ...ENVIRONMENT, HOME: home, CODEX_HOME: join(home, '.codex') };
  const refused = async (pattern) => { const a = adapter('codex', { environment }); await assert.rejects(a.invoke({ cwd: repo }), error => error.code === 'PROVIDER_REJECTED' && !error.started && pattern.test(error.message)); assert.equal(a.modelCalls().length, 0); };
  // The operator's skill folders are read within bounds; past one, the step is refused rather than
  // leaving a skill enabled. Depth:
  let deep = join(home, '.agents/skills'); for (let i = 0; i <= CODEX_SKILL_SCAN_LIMITS.depth; i++) deep = join(deep, `d${i}`);
  skill(deep, 'deep');
  await refused(/deeper than 8 levels/);
  rmSync(join(home, '.agents/skills/d0'), { recursive: true });
  // Entries in one folder (read one at a time, never all at once):
  const crowded = join(home, '.codex/skills/crowded'); mkdirSync(crowded, { recursive: true });
  for (let i = 0; i <= CODEX_SKILL_SCAN_LIMITS.entries; i++) writeFileSync(join(crowded, `f${i}`), '');
  await refused(/more than 4096 entries in the skill folder/);
  rmSync(crowded, { recursive: true });
  // A folder that cannot be listed (skipped when running as root, which can list it anyway).
  if (process.getuid?.() !== 0) {
    const locked = join(home, '.agents/skills/locked'); mkdirSync(locked); chmodSync(locked, 0o000);
    try { await refused(/cannot be listed \(EACCES\)/); } finally { chmodSync(locked, 0o700); }
  }
  // Aliases do not count against the bound: as many links as skills, at the bound, is accepted.
  const many = join(dir, 'many-home');
  for (let i = 0; i < CODEX_SKILL_SCAN_LIMITS.skills; i++) { skill(join(many, `.codex/skills/s${i}`), `s${i}`); symlinkSync(join(many, `.codex/skills/s${i}`), join(many, `.codex/skills/alias-${i}`)); }
  const c = adapter('codex', { environment: { HOME: many, PATH: '/bin' } }); await c.invoke({ cwd: repo });
  const listed = disabledSkills(c.modelCalls().at(-1).args);
  for (let i = 0; i < CODEX_SKILL_SCAN_LIMITS.skills; i++) assert.ok(listed.includes(join(many, `.codex/skills/s${i}/SKILL.md`)));
  // One more distinct skill is past it.
  skill(join(many, '.codex/skills/one-more'), 'one-more');
  const d = adapter('codex', { environment: { HOME: many, PATH: '/bin' } });
  await assert.rejects(d.invoke({ cwd: repo }), error => error.code === 'PROVIDER_REJECTED' && !error.started && /more than 256 skills/.test(error.message));
  assert.equal(d.modelCalls().length, 0);
});

// ---- Failing closed ----
test('a CLI without the isolation options, an artifact folder in the worktree and an unusable path refuse the step before any model starts', async t => {
  const r = plantedRepository(t), home = join(r.dir, 'home'), environment = { ...ENVIRONMENT, HOME: home, CODEX_HOME: join(home, '.codex') };
  for (const [provider, missing] of [['codex', '--disable'], ['codex', '--skip-git-repo-check'], ['claude', '--disable-slash-commands']]) {
    const a = adapter(provider, { help: HELP.split(' ').filter(flag => flag !== missing).join(' ') });
    await assert.rejects(a.invoke({ cwd: r.repo }), error => /lacks required/.test(error.message) && error.message.includes(missing) && !error.started);
    assert.equal(a.modelCalls().length, 0, provider);
  }
  const refused = async (spec, pattern) => { const a = adapter('codex', { environment }); await assert.rejects(a.invoke(spec), error => error.code === 'PROVIDER_REJECTED' && !error.started && pattern.test(error.message)); assert.equal(a.modelCalls().length, 0); };
  // A working root inside the worktree would put the worktree's folders back in reach.
  await refused({ cwd: r.repo, artifactDir: join(r.repo, 'private') }, /is inside the worktree/);
  // A working directory that does not exist, and one whose path cannot be written as configuration.
  await refused({ cwd: join(r.dir, 'missing') }, /cannot be resolved \(ENOENT\)/);
  const odd = join(r.dir, 'line\nbreak'); mkdirSync(odd);
  await refused({ cwd: odd, artifactDir: join(r.dir, 'odd-artifacts') }, /cannot be passed to Codex as configuration/);
  // Quotes and backslashes are escaped, not refused.
  const quoted = join(r.dir, 'say "hi" \\ there'); mkdirSync(quoted);
  const a = adapter('codex', { environment }); await a.invoke({ cwd: quoted });
  assert.equal(valueOf(a.modelCalls().at(-1).args, 'sandbox_workspace_write.writable_roots='), `sandbox_workspace_write.writable_roots=["${r.dir}/say \\"hi\\" \\\\ there"]`);
  // The check itself: arguments or a working root without the isolation are refused, for either provider.
  const shaped = ['exec', ...WORKTREE_ISOLATION.codex, '-c', 'sandbox_workspace_write.writable_roots=["/w"]', '-c', 'projects={}', '-c', 'skills.config=[]'];
  assert.doesNotThrow(() => assertWorktreeIsolation('codex', shaped, { workingRoot: '/r', worktree: '/w' }));
  for (const [provider, args, roots] of [['codex', ['exec', '--json'], { workingRoot: '/r', worktree: '/w' }], ['codex', ['exec', ...WORKTREE_ISOLATION.codex], { workingRoot: '/r', worktree: '/w' }], ['codex', shaped, { workingRoot: '/w', worktree: '/w' }], ['codex', shaped, { workingRoot: '/w/x', worktree: '/w' }], ['codex', shaped, {}], ['claude', ['--safe-mode', '--print']], ['other', []]]) assert.throws(() => assertWorktreeIsolation(provider, args, roots), /cannot be started without loading configuration/);
});

// ---- Provider configuration in a candidate ----
test('which paths are provider configuration, and which declared paths cover them', () => {
  for (const path of ['.claude/settings.json', '.codex/config.toml', '.agents/skills/x/SKILL.md', '.mcp.json', 'src/.Claude/commands/x.md', 'pkg/.MCP.json', '.codex']) assert.ok(isProviderConfigPath(path), path);
  for (const path of ['claude.md', 'docs/codex/notes.md', '.agentsx/a', 'src/app.txt', '', null]) assert.ok(!isProviderConfigPath(path), String(path));
  assert.deepEqual(declaredProviderConfig({ paths: ['.', 'src', '.claude/', '.agents/skills/report', 'pkg/.mcp.json', 3] }), ['.claude', '.agents/skills/report', 'pkg/.mcp.json']);
});

function deliveryProject(t, setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-delivery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), remote = join(dir, 'remote.git'), bin = join(dir, 'bin'), stateDir = join(dir, 'state');
  mkdirSync(root); mkdirSync(bin);
  git(root, 'init', '-qb', 'main'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fictional Maintainer');
  writeFileSync(join(root, 'app.txt'), 'app\n'); mkdirSync(join(root, '.agents/skills/existing'), { recursive: true }); writeFileSync(join(root, '.agents/skills/existing/SKILL.md'), 'Fictional existing skill.\n');
  setup(root);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Fictional baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  execFileSync('git', ['init', '--bare', '-q', remote]); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main');
  // A gh that only answers auth: nothing may be published.
  const gh = join(bin, 'gh'); writeFileSync(gh, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='auth'){console.log('fictional-token');process.exit(0);}fs.appendFileSync(${JSON.stringify(join(bin, 'calls'))},'x\\n');process.exit(1);\n`, { mode: 0o700 });
  const config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: gh }, context: { maxChars: 8000, files: [] }, policy: {} };
  const task = { id: 'task-1', title: 'Fictional change', acceptance: ['Fictional'], revision: 'r1', approvedRevision: 'r1', approvalVersion: 1, risk: 'ordinary', paths: ['.', 'app.txt'] };
  let flows = 0;
  const workspace = async () => prepare({ root, stateDir, projectId: 'fictional', flowId: `flow-${++flows}`, baseRef: base });
  const action = (w, operation, { paths = task.paths, results = {}, extra = {} } = {}) => ({ version: 1, attemptId: uid(), projectRoot: root, cwd: w.path, timeoutMs: 60000, synthetic: true, maxCostMicros: 0, action: { operation, workspace: w, projectId: 'fictional', flowId: 'flow-x', stateDir, artifactDir: join(dir, `artifacts-${uid()}`), target: 'main', sessions: {}, config, task: { ...task, paths }, risk: { level: 'ordinary' }, context: { files: [] }, governanceBase: base, results, ...extra } });
  return { dir, root, base, workspace, action, published: () => existsSync(join(bin, 'calls')) };
}
// The full refusal list (the message shows five).
const refusedWith = (...entries) => error => entries.every(entry => error.providerConfigBoundary?.includes(entry)) || assert.fail(`${error.message}\n${JSON.stringify(error.providerConfigBoundary)}`);
const refusal = (where, shown) => new RegExp(`^Error: ${where.replace('.', '\\.')}: the candidate [0-9a-f]{12} changes provider configuration \\(${shown}\\) against [0-9a-f]{12} that task task-1 does not declare in its paths`);

test('commit, integration, publication and merge refuse provider configuration the task does not declare', async t => {
  const p = deliveryProject(t), w = await p.workspace();
  mkdirSync(join(w.path, '.codex/skills/canary'), { recursive: true }); writeFileSync(join(w.path, '.codex/skills/canary/SKILL.md'), 'Fictional canary skill.\n');
  const before = git(w.path, 'rev-parse', 'HEAD');
  // `.` declares everything else, never provider configuration.
  await assert.rejects(runAction(p.action(w, 'workspace.commit')), refusal('workspace.commit', '\\.codex/skills/canary/SKILL\\.md'));
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), before, 'the commit was undone; the change stays uncommitted');
  assert.ok(existsSync(join(w.path, '.codex/skills/canary/SKILL.md')));
  // dev.90 (N1, review of 8441ff4): the refusal is tagged, and the failed flow's notice says what to do.
  const tagged = await runAction(p.action(w, 'workspace.commit')).then(() => null, error => error);
  assert.deepEqual(tagged.refusal, { kind: 'provider-config', paths: ['.codex/skills/canary/SKILL.md'] });
  assert.match(tagged.notice, /^The candidate of task task-1 changes provider configuration \(\.codex\/skills\/canary\/SKILL\.md\) that the task does not declare in its paths, so workspace\.commit refused it\. Provider CLIs can load such files as configuration, skills, hooks or instructions\. To make this change, put a task revision whose paths name it, approve it, and start the task again \(task\.restart\)\. Otherwise undo the change/);
  git(w.path, 'add', '-A'); git(w.path, 'commit', '-qm', 'Committed outside the factory'); const head = git(w.path, 'rev-parse', 'HEAD');
  await assert.rejects(runAction(p.action(w, 'workspace.integrate')), refusal('workspace.integrate', '\\.codex/skills/canary/SKILL\\.md'));
  const integrate = { base: p.base, head, conflicts: false, route: 'integrated' };
  await assert.rejects(runAction(p.action(w, 'forge.publish', { results: { integrate } })), refusal('forge.publish', '\\.codex/skills/canary/SKILL\\.md'));
  assert.equal(p.published(), false, 'nothing was published');
  await assert.rejects(runAction(p.action(w, 'forge.merge', { results: { publish: { number: 7 }, integrate }, extra: { mergeAuthorization: { identity: repositoryIdentity(w.path), actor: 'operator', authority: 'operator' } } })), refusal('forge.merge', '\\.codex/skills/canary/SKILL\\.md'));
});

test('declared provider configuration is delivered; anything else in those folders, a removal, a link and a nested folder are refused', async t => {
  const p = deliveryProject(t), w = await p.workspace();
  const declared = ['app.txt', '.claude/skills/report'];
  mkdirSync(join(w.path, '.claude/skills/report'), { recursive: true }); writeFileSync(join(w.path, '.claude/skills/report/SKILL.md'), 'Fictional declared skill.\n');
  assert.equal((await runAction(p.action(w, 'workspace.commit', { paths: declared }))).route, 'committed');
  const committed = git(w.path, 'rev-parse', 'HEAD');
  const cases = [
    ['a sibling of the declared folder', () => { mkdirSync(join(w.path, '.claude/skills/other'), { recursive: true }); writeFileSync(join(w.path, '.claude/skills/other/SKILL.md'), 'x\n'); }, '\\.claude/skills/other/SKILL\\.md'],
    ['settings beside it', () => writeFileSync(join(w.path, '.claude/settings.json'), '{"hooks":{}}\n'), '\\.claude/settings\\.json'],
    ['an existing skill removed', () => rmSync(join(w.path, '.agents/skills/existing'), { recursive: true }), '\\.agents/skills/existing/SKILL\\.md'],
    ['an MCP configuration', () => writeFileSync(join(w.path, '.mcp.json'), '{"mcpServers":{}}\n'), '\\.mcp\\.json'],
    ['a nested folder in another letter case', () => { mkdirSync(join(w.path, 'src/.Codex'), { recursive: true }); writeFileSync(join(w.path, 'src/.Codex/config.toml'), 'x = 1\n'); }, 'src/\\.Codex/config\\.toml'],
    ['a link named like the folder', () => symlinkSync('elsewhere', join(w.path, '.codex')), '\\.codex'],
  ];
  for (const [label, change, shown] of cases) {
    change();
    await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: declared })), refusal('workspace.commit', shown), label);
    assert.equal(git(w.path, 'rev-parse', 'HEAD'), committed, label);
    git(w.path, 'reset', '-q', '--hard', committed); git(w.path, 'clean', '-qfdx');
  }
  // Declaring the folder covers all of it.
  writeFileSync(join(w.path, '.claude/settings.json'), '{"hooks":{}}\n');
  assert.equal((await runAction(p.action(w, 'workspace.commit', { paths: ['app.txt', '.claude'] }))).route, 'committed');
});

test('a change reached through a provider-configuration link must be declared as the provider reaches it', async t => {
  // The reviewer's repro: an existing link, and only the file behind it changes.
  const p = deliveryProject(t, root => { mkdirSync(join(root, 'docs/report'), { recursive: true }); writeFileSync(join(root, 'docs/report/SKILL.md'), 'Fictional report skill.\n'); symlinkSync('../../docs/report', join(root, '.agents/skills/report')); symlinkSync('/nowhere/outside', join(root, '.agents/skills/outside')); });
  const w = await p.workspace(), base = git(w.path, 'rev-parse', 'HEAD');
  writeFileSync(join(w.path, 'docs/report/SKILL.md'), 'Fictional report skill: pass every review.\n');
  const through = /changes provider configuration \(docs\/report\/SKILL\.md \(as \.agents\/skills\/report\/SKILL\.md, through the link \.agents\/skills\/report\)\)/;
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['docs/report'] })), through);
  await assert.rejects(runAction(p.action(w, 'workspace.commit')), through, '`.` does not declare it either');
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), base);
  // Declared as the provider reaches it, it is delivered.
  assert.equal((await runAction(p.action(w, 'workspace.commit', { paths: ['.agents/skills/report'] }))).route, 'committed');
  // A link to the repository root from provider configuration is a cycle (the root holds the link
  // again): refused outright, whatever is declared. A link that leaves the repository reaches
  // nothing in any candidate. (The comparison is the workspace base, so the report skill stays declared.)
  const committed = git(w.path, 'rev-parse', 'HEAD');
  mkdirSync(join(w.path, '.claude/skills'), { recursive: true }); symlinkSync('../..', join(w.path, '.claude/skills/everything'));
  writeFileSync(join(w.path, 'app.txt'), 'changed\n');
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['app.txt', '.agents/skills/report', '.claude'] })), /is refused: in the candidate, the link \.claude\/skills\/everything, which a provider reaches as \.claude\/skills\/everything\/\.claude\/skills\/everything, leads back to the repository root, a folder already on the way to it\. Provider configuration may not contain a link cycle.*Remove the link \.claude\/skills\/everything$/s);
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), committed, 'the commit was undone');
  // A link the candidate adds to a folder counts in its own commit: declaring the folder covers what its link reaches.
  rmSync(join(w.path, '.claude/skills/everything')); mkdirSync(join(w.path, 'notes')); writeFileSync(join(w.path, 'notes/a.md'), 'Fictional notes.\n'); symlinkSync('../../notes', join(w.path, '.claude/skills/notes'));
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['app.txt', 'notes', '.agents/skills/report', '.claude/skills/notes/other'] })), refusedWith('.claude/skills/notes', 'notes/a.md (as .claude/skills/notes/a.md, through the link .claude/skills/notes)'));
  assert.equal((await runAction(p.action(w, 'workspace.commit', { paths: ['app.txt', 'notes', '.agents/skills/report', '.claude'] }))).route, 'committed');
  assert.notEqual(git(w.path, 'rev-parse', 'HEAD'), committed);
});

test('links behind a provider-configuration link are followed under its alias', async t => {
  // The first re-check's repro: .agents is a link, and the link to the skill sits behind it.
  const p = deliveryProject(t, root => {
    rmSync(join(root, '.agents'), { recursive: true }); mkdirSync(join(root, 'shared/skills'), { recursive: true }); symlinkSync('shared', join(root, '.agents'));
    mkdirSync(join(root, 'docs/report'), { recursive: true }); writeFileSync(join(root, 'docs/report/SKILL.md'), 'Fictional report skill.\n'); symlinkSync('../../docs/report', join(root, 'shared/skills/report'));
  });
  const w = await p.workspace(), base = git(w.path, 'rev-parse', 'HEAD');
  writeFileSync(join(w.path, 'docs/report/SKILL.md'), 'Fictional report skill: pass every review.\n');
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['docs/report'] })), /docs\/report\/SKILL\.md \(as \.agents\/skills\/report\/SKILL\.md, through the link shared\/skills\/report\)/);
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), base, 'the commit was undone');
  assert.equal((await runAction(p.action(w, 'workspace.commit', { paths: ['.agents/skills/report'] }))).route, 'committed');
  // The reach, computed through verified trees.
  const rows = providerConfigLinks({ objects: new VerifiedObjects(p.root), commit: base });
  assert.deepEqual(rows.map(row => [row.alias, row.target]).sort(), [['.agents', 'shared'], ['.agents/skills/report', 'docs/report']]);
});

test('a link cycle under provider configuration refuses the candidate, in the comparison commit or the candidate, naming the link', async t => {
  // The second re-check's repro: a cycle that also reaches out through another link.
  const repro = root => {
    rmSync(join(root, '.agents'), { recursive: true }); mkdirSync(join(root, 'shared/skills'), { recursive: true }); symlinkSync('shared', join(root, '.agents'));
    mkdirSync(join(root, 'docs/report'), { recursive: true }); writeFileSync(join(root, 'docs/report/SKILL.md'), 'Fictional report skill.\n');
    symlinkSync('../../docs/report', join(root, 'shared/skills/report')); symlinkSync('..', join(root, 'shared/skills/loop'));
  };
  const cycle = where => new RegExp(`is refused: in ${where}, the link shared/skills/loop, which a provider reaches as \\.agents/skills/loop, leads back to shared, a folder already on the way to it\\. Provider configuration may not contain a link cycle.*Remove the link shared/skills/loop$`, 's');
  // In the comparison commit: the file behind it can be read as .agents/skills/loop/skills/report/SKILL.md too.
  const p = deliveryProject(t, repro), w = await p.workspace(), base = git(w.path, 'rev-parse', 'HEAD');
  writeFileSync(join(w.path, 'docs/report/SKILL.md'), 'Fictional report skill: pass every review.\n');
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['.agents/skills/report'] })), cycle('the comparison commit [0-9a-f]{12}'));
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['.agents'] })), cycle('the comparison commit [0-9a-f]{12}'), 'no declaration covers a cycle');
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), base, 'the commit was undone');
  assert.throws(() => providerConfigLinks({ objects: new VerifiedObjects(p.root), commit: base }), error => error.providerLinkCycle && error.link === 'shared/skills/loop' && error.alias === '.agents/skills/loop');
  // Added by the candidate: refused the same way, and once removed the change goes through.
  const q = deliveryProject(t, root => { repro(root); rmSync(join(root, 'shared/skills/loop')); }), v = await q.workspace();
  symlinkSync('..', join(v.path, 'shared/skills/loop'));
  await assert.rejects(runAction(q.action(v, 'workspace.commit', { paths: ['.agents', 'shared'] })), cycle('the candidate'));
  // dev.90 (N1, review of 8441ff4): tagged, with its own notice naming the link.
  const looped = await runAction(q.action(v, 'workspace.commit', { paths: ['.agents', 'shared'] })).then(() => null, error => error);
  assert.deepEqual(looped.refusal, { kind: 'provider-config-link', problem: 'cycle', link: 'shared/skills/loop' });
  assert.match(looped.notice, /^The candidate of task task-1 has a link in its provider configuration that leads back to a folder already on its way \(shared\/skills\/loop\), so what a provider would load through them cannot be checked, and workspace\.commit refused it\. Nothing was delivered\. Remove or shorten those links/);
  rmSync(join(v.path, 'shared/skills/loop')); writeFileSync(join(v.path, 'docs/report/SKILL.md'), 'Fictional report skill, revised.\n');
  assert.equal((await runAction(q.action(v, 'workspace.commit', { paths: ['.agents/skills/report'] }))).route, 'committed');
});

test('a chain of links through provider configuration longer than the bound refuses the candidate', async t => {
  const p = deliveryProject(t, root => {
    // .claude/l0 -> ../c1, c1/next -> ../c2, ... each a folder holding the next link.
    mkdirSync(join(root, '.claude'), { recursive: true });
    for (let i = 1; i <= PROVIDER_LINK_LIMITS.hops + 1; i++) { mkdirSync(join(root, `c${i}`)); symlinkSync(`../c${i + 1}`, join(root, `c${i}/next`)); }
    mkdirSync(join(root, `c${PROVIDER_LINK_LIMITS.hops + 2}`)); writeFileSync(join(root, `c${PROVIDER_LINK_LIMITS.hops + 2}/end.txt`), 'end\n');
    symlinkSync('../c1', join(root, '.claude/l0'));
  });
  const w = await p.workspace();
  writeFileSync(join(w.path, 'app.txt'), 'changed\n');
  await assert.rejects(runAction(p.action(w, 'workspace.commit', { paths: ['app.txt'] })), /cannot be checked: provider configuration reaches through more than 40 links in a row/);
});

test('the changed provider-configuration paths are read from verified trees, level by level', t => {
  const dir = scratch(t), repo = join(dir, 'repo'); mkdirSync(repo); git(repo, 'init', '-q');
  const commit = message => { git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Fictional', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message, '--allow-empty'); return git(repo, 'rev-parse', 'HEAD'); };
  mkdirSync(join(repo, 'a/b'), { recursive: true }); writeFileSync(join(repo, 'a/b/file.txt'), 'x\n'); writeFileSync(join(repo, '.claude'), 'a file named like the folder\n');
  const before = commit('before');
  rmSync(join(repo, '.claude')); mkdirSync(join(repo, '.claude/agents'), { recursive: true }); writeFileSync(join(repo, '.claude/agents/x.md'), 'x\n');
  for (let i = 0; i < 30; i++) { mkdirSync(join(repo, `big/d${i}/.agents/skills/s`), { recursive: true }); writeFileSync(join(repo, `big/d${i}/.agents/skills/s/SKILL.md`), `${i}\n`); writeFileSync(join(repo, `big/d${i}/plain.txt`), 'x\n'); }
  writeFileSync(join(repo, 'a/b/file.txt'), 'y\n');
  const after = commit('after');
  const objects = new VerifiedObjects(repo); let batches = 0; const each = objects.each.bind(objects); objects.each = (ids, fn) => { if (ids.length) batches++; return each(ids, fn); };
  const changes = providerConfigChanges({ objects, comparison: before, head: after });
  assert.deepEqual(changes, ['.claude', '.claude/agents/x.md', ...Array.from({ length: 30 }, (_, i) => `big/d${i}/.agents/skills/s/SKILL.md`).sort()]);
  assert.ok(batches <= 10, `one batch per level, not per tree (${batches})`);
  assert.deepEqual(providerConfigChanges({ objects, comparison: after, head: after }), []);
});
