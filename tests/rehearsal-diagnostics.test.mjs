// dev.83: the shipped rehearsal workflow template initializes once its commands are replaced (G17),
// a failed trusted command says why outside the state directory (G19), a refused resume names the
// unsettled attempt and what to do (G20), and a missing or invalid option value is a usage error,
// not a stack trace (G21). Every project here is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandbox, until } from './helpers.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { inspect } from '../starter/factory/core/effects.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';

const STARTER = join(process.cwd(), 'starter');
const TEMPLATE = join(STARTER, 'project/workflow.template.json');
const temp = t => { const base = mkdtempSync(join(tmpdir(), 'rehearsal-')); t.after(() => rmSync(base, { recursive: true, force: true })); return base; };
const repository = root => { mkdirSync(root, { recursive: true }); for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['commit', '-q', '--allow-empty', '-m', 'Fictional baseline']]) execFileSync('git', args, { cwd: root }); };
// The placeholders replaced the way a first rehearsal does: each by one trusted command.
const filled = (text, command = 'true') => text.replace(/"CONFIGURE_[A-Z_]*"/g, JSON.stringify(command));

// ---- G17 ----

for (const prefix of ['', 'tools/factotum']) {
  test(`G17: the shipped workflow template passes init once its commands are replaced (${prefix || 'repository root'})`, t => {
    const base = temp(t), root = join(base, 'repo'); repository(root);
    const installed = join(root, prefix); cpSync(STARTER, installed, { recursive: true });
    const workflow = join(base, 'workflow.json'); writeFileSync(workflow, filled(readFileSync(join(installed, 'project/workflow.template.json'), 'utf8')));
    const result = spawnSync(process.execPath, [join(installed, 'factory/cli.mjs'), 'init', '--root', root, '--state', join(base, 'state'), '--name', 'Fictional rehearsal', '--workflow', workflow, '--supervisor', 'process'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, 'Fictional rehearsal');
  });
}

test('G17: the filled template rehearses to its decision question with both observations recorded', async t => {
  const base = temp(t), root = join(base, 'repo'), stateDir = join(base, 'state'); repository(root);
  const ok = JSON.parse(filled(readFileSync(TEMPLATE, 'utf8')));
  for (const key of ['build', 'review', 'gate']) ok.nodes[key].argv = [process.execPath, '-e', 'process.exit(0)'];
  const project = initProject({ stateDir, root, name: 'Fictional rehearsal', workflow: ok, supervisor: 'process' });
  const store = new Store(stateDir), engine = new Engine(store); t.after(() => store.close());
  const command = (operation, payload) => executeCommand(store, { protocolVersion: 1, projectId: project.projectId, commandId: uid(), operation, payload, actor: 'operator' });
  command('task.put', { task: { id: 'task-1', title: 'Fictional rehearsal', acceptance: ['The rehearsal reaches its question'] } });
  command('task.approve', { taskId: 'task-1', revision: store.need('task', 'task-1').revision });
  command('flow.start', { taskId: 'task-1', flowId: 'flow-1' });
  const question = await until(() => store.all('inbox').find(row => row.kind === 'question' && row.flowId === 'flow-1'), { tick: () => engine.tick() });
  assert.equal(store.need('flow', 'flow-1').step, 'decision');
  assert.deepEqual(Object.keys(store.need('flow', 'flow-1').evidence).sort(), ['rehearsal:gate', 'rehearsal:review']);
  assert.ok(question.answers.includes('continue'));
});

// ---- G19 ----

const FAILING = [process.execPath, '-e', 'console.log("checked 3 files"); console.error("fixture data.csv missing\\u001b[31m red\\u001b[0m; token ghp_abcdefghijklmnop0123"); process.exit(3)'];

test('G19: a failed trusted command records how it ended and its last output, in the notice and the flow view', async t => {
  const f = sandbox(t, { argv: FAILING }); f.start();
  const flow = await until(() => { const row = f.store.need('flow', 'flow-1'); return row.state === 'failed' ? row : null; }, { tick: () => f.engine.tick() });
  const attempt = f.store.all('attempt').find(row => row.flowId === flow.id);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.reason, 'the command exited with code 3');
  assert.equal(attempt.failure.exitCode, 3);
  assert.equal(attempt.failure.stdout, 'checked 3 files');
  assert.match(attempt.failure.stderr, /^fixture data\.csv missing red; token \[redacted\]$/, 'control sequences stripped, credential-like text redacted');
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === flow.id);
  // The failure is the attempt's notice, and the flow notice carries it the way it carries an action's.
  assert.match(attempt.notice, /^The command exited with code 3\.\nstderr \(last lines\):\n/);
  assert.ok(notice.context.startsWith(`Failed at work (attempt ${attempt.id}): ${attempt.notice}`));
  assert.match(notice.context, /stderr \(last lines\):\nfixture data\.csv missing red/);
  assert.match(notice.context, /stdout \(last lines\):\nchecked 3 files/);
  const view = stateView(f.store, { flow: flow.id });
  assert.equal(view.attempts[0].reason, 'the command exited with code 3');
  assert.equal(view.attempts[0].failure.exitCode, 3);
});

test('G19: the excerpt is bounded to the last lines and characters of each log', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'for (let i = 0; i < 5000; i++) console.error(`line ${i} ` + "x".repeat(40)); process.exit(1)'] }); f.start();
  await until(() => f.store.need('flow', 'flow-1').state === 'failed', { tick: () => f.engine.tick() });
  const { failure } = f.store.all('attempt').find(row => row.flowId === 'flow-1');
  assert.ok(failure.stderr.length <= 1200, String(failure.stderr.length));
  assert.ok(failure.stderr.split('\n').length <= 12);
  assert.match(failure.stderr, /line 4999 x+$/);
  assert.equal(failure.stdout, undefined);
});

// ---- G20 ----

test('G20: resume refused while the stopped step still runs names the attempt and says to resume again, then works', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'setTimeout(() => {}, 1500)'] }); f.start();
  const attempt = await until(() => f.store.all('attempt').find(row => row.flowId === 'flow-1' && inspect(f.store, row).kind === 'running'), { tick: () => f.engine.tick() });
  f.command('stop', { flowId: 'flow-1', note: 'Pause the fictional rehearsal' });
  const refused = f.command('resume', { flowId: 'flow-1', note: 'Continue the fictional rehearsal' });
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, new RegExp(`attempt ${attempt.id} \\(step work\\) of flow flow-1 has not settled`));
  assert.match(refused.error, /its process is still running/); assert.match(refused.error, /Nothing needs reconciling: resume again when the step has finished/);
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick() });
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'Continue the fictional rehearsal' }).status, 'completed');
});

test('G20: resume refused on an uncertain attempt gives the exact command to settle it', t => {
  const f = sandbox(t); f.start();
  const attempt = { id: 'uncertain-1', flowId: 'flow-1', step: 'work', status: 'uncertain', reason: 'dispatch has no live owner or terminal receipt', intent: { argv: ['true'] }, createdAt: new Date().toISOString() };
  f.store.put('attempt', attempt);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'stopped', stopRequested: true, attemptId: attempt.id });
  const refused = f.command('resume', { flowId: 'flow-1', note: 'Continue the fictional rehearsal' });
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /attempt uncertain-1 \(step work\) of flow flow-1 has not settled/);
  assert.match(refused.error, /outcome is uncertain \(dispatch has no live owner or terminal receipt\)/);
  assert.match(refused.error, /command --actor operator --state \S+ --operation attempt\.resolve --payload '\{"attemptId":"uncertain-1","disposition":"failed","costMicros":0,"note":"<what you inspected>"\}'/);
  assert.doesNotMatch(refused.error, /reconcile --state/, 'a trusted command has no typed reconciler');
  // The running guide explains the refusal under the same words.
  assert.match(readFileSync(join(process.cwd(), 'docs/running.md'), 'utf8'), /\*\*"has not settled, so the flow cannot resume yet"\.\*\*/);
});

// ---- G21 ----

const cli = (args, options = {}) => spawnSync(process.execPath, [join(STARTER, 'factory/cli.mjs'), ...args], { encoding: 'utf8', ...options });
test('G21: a missing, ambiguous or invalid option value is a usage error without a stack trace', t => {
  const state = join(temp(t), 'state');
  for (const [args, message] of [
    [['status', '--state', state, '--inbox'], /^factotum status: --inbox needs a value\nUsage: status --state <dir>/],
    [['status', '--state', '--inbox', 'x'], /^factotum status: --state needs a value \(the next argument starts with "-"; write --state=<value> if that is the value\)/],
    [['status', '--state', state, '--bogus'], /^factotum status: unknown option --bogus/],
    [['status', '--compact=yes'], /^factotum status: --compact takes no value/],
    [['console', '--state', state, '--port', 'abc'], /^factotum console: --port must be a whole number from 0 to 65535, not "abc"\nUsage: console/],
    [['upgrade', 'apply', '--max-wait-hours', 'soon'], /^factotum upgrade: --max-wait-hours must be a number from 0 to 8760, not "soon"\nUsage: upgrade apply/],
    [['import-task', '--state', state, '--issue', '0'], /^factotum import-task: --issue must be a whole number from 1/],
    [['adopt', 'install', '--root'], /^factotum adopt: --root needs a value\nUsage: adopt install .*\nRun adopt install --help for the options\.$/m],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message, args.join(' '));
    assert.doesNotMatch(result.stderr, /\n\s+at |TypeError|ERR_PARSE_ARGS/, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('G21: the triage example refuses a missing option value with a message', () => {
  const result = spawnSync(process.execPath, [join(STARTER, 'project/integrations/triage.example.mjs'), '--counts', '--since'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stderr, 'triage: --since needs a value\n');
});

// ---- Review fixes ----

test('review P1: known secrets are redacted from a failed command\'s output, summary, notice and flow view', async t => {
  const secret = 'synthetic-openai-value-7f3a91', before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret; t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  const b64 = Buffer.from(secret).toString('base64');
  // Printed bare (no key= prefix the pattern rules would catch), and base64-encoded.
  const f = sandbox(t, { argv: [process.execPath, '-e', `console.error(${JSON.stringify(secret)}); console.log(${JSON.stringify(b64)}); process.exit(1)`] }); f.start();
  await until(() => f.store.need('flow', 'flow-1').state === 'failed', { tick: () => f.engine.tick() });
  const attempt = f.store.all('attempt').find(row => row.flowId === 'flow-1');
  assert.equal(attempt.failure.stderr, '[redacted]'); assert.equal(attempt.failure.stdout, '[redacted]');
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === 'flow-1');
  // The test's own command line holds the secret (attempt.intent): everything recorded from its output must not.
  const shown = JSON.stringify({ failure: attempt.failure, reason: attempt.reason, notice, view: stateView(f.store, { flow: 'flow-1' }) });
  assert.ok(!shown.includes(secret) && !shown.includes(b64.replace(/=+$/, '')), 'no form of the secret is recorded');
});

test('review P1: a known secret in a launch error is redacted from the summary', async t => {
  const secret = 'synthetic-openai-value-launch-55', before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret; t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  const f = sandbox(t, { argv: [`/nonexistent/${secret}`] }); f.start();
  await until(() => f.store.need('flow', 'flow-1').state === 'failed', { tick: () => f.engine.tick() });
  const attempt = f.store.all('attempt').find(row => row.flowId === 'flow-1');
  assert.match(attempt.failure.summary, /^the command could not start \(.*\[redacted\]/);
  assert.ok(!JSON.stringify([attempt.failure, attempt.reason, f.store.all('inbox'), stateView(f.store, { flow: 'flow-1' })]).includes(secret));
});

test('review P3: the uncertain-attempt recovery command quotes a state path that needs it', t => {
  const f = sandbox(t); f.start();
  f.store.stateDir = `${f.store.stateDir}/with space`; // only the message reads it here
  f.store.put('attempt', { id: 'uncertain-2', flowId: 'flow-1', step: 'work', status: 'uncertain', reason: 'no receipt', intent: { argv: ['true'] }, createdAt: new Date().toISOString() });
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'stopped', stopRequested: true, attemptId: 'uncertain-2' });
  const refused = f.command('resume', { flowId: 'flow-1', note: 'Continue the fictional rehearsal' });
  assert.match(refused.error, new RegExp(`--state '${f.store.stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' --operation attempt\\.resolve`));
  assert.match(refused.error, /Inspect '[^']*\/with space\/attempts\/uncertain-2'/);
});

test('review P2: command lines accepted before still pass option checking (omitted numbers keep their defaults)', t => {
  const base = temp(t), state = join(base, 'missing-state');
  // A console starts serving (it creates its state): stopped after a moment; it must not have refused its options.
  for (const args of [['console', '--state', join(base, 'console-a')], ['console', '--state', join(base, 'console-b'), '--port', '0']]) {
    const result = cli(args, { timeout: 3000, killSignal: 'SIGKILL' });
    assert.notEqual(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /^factotum \S+: |must be a whole number|needs a value/, args.join(' '));
  }
  // Each fails later for its own reason (no state, nothing to do), never as a usage error.
  for (const args of [['import-task', '7', '--state', state, '--actor', 'operator'], ['import-task', '--issue', '7', '--state', state, '--actor', 'operator'], ['upgrade', 'apply', '--state', state, '--root', base], ['upgrade', 'apply', '--state', state, '--root', base, '--max-wait-hours', '1.5'], ['status', '--state', state]]) {
    const result = cli(args);
    assert.notEqual(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /^factotum \S+: |must be a whole number|needs a value/, args.join(' '));
  }
});

test('review P2: service install console without --port writes a unit with port 0, and with --port that port', t => {
  const base = temp(t), bin = join(base, 'bin'), log = join(base, 'calls.log'); mkdirSync(bin);
  // Stand-ins for systemctl and loginctl: record the call, change nothing.
  for (const name of ['systemctl', 'loginctl']) { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 0\n`, { mode: 0o755 }); }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(base, 'config') };
  const unit = () => readFileSync(join(base, 'config/systemd/user/factotum-console.service'), 'utf8');
  const omitted = spawnSync(process.execPath, [join(STARTER, 'factory/cli.mjs'), 'service', 'install', 'console', '--state', join(base, 'console'), '--no-start'], { encoding: 'utf8', env });
  assert.equal(omitted.status, 0, omitted.stderr); assert.match(unit(), /--port 0\n/);
  const given = spawnSync(process.execPath, [join(STARTER, 'factory/cli.mjs'), 'service', 'install', 'console', '--state', join(base, 'console'), '--port', '8080', '--replace', '--no-start'], { encoding: 'utf8', env });
  assert.equal(given.status, 0, given.stderr); assert.match(unit(), /--port 8080\n/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /--now/);
});

// ---- Merge of the dev.83 console fixes: one notice mechanism ----

test('merge: a failed command\'s notice and an action\'s notice reach the failed-flow notice through the same path', async () => {
  const { attemptNotice, failedChangeReason, failedFlowNotice } = await import('../starter/factory/core/engine.mjs');
  const rows = [];
  const store = { by: (kind, field, value) => rows.filter(row => row.flowId === value) };
  rows.push({ id: 'a1', flowId: 'f', step: 'integrate', status: 'failed', receipt: { actionResult: { notice: 'Adopted pull request #1 changes managed files.' } } });
  assert.equal(failedChangeReason(store, 'f'), 'Change workflow failed at integrate: Adopted pull request #1 changes managed files.');
  rows.push({ id: 'a2', flowId: 'f', step: 'check', status: 'failed', notice: 'The command exited with code 2.\nstderr (last lines):\nassertion failed' });
  assert.equal(attemptNotice(rows[1]), rows[1].notice);
  assert.equal(failedChangeReason(store, 'f'), 'Change workflow failed at check: The command exited with code 2.\nstderr (last lines):\nassertion failed');
  assert.equal(failedFlowNotice(store, 'f'), 'Failed at check (attempt a2): The command exited with code 2.\nstderr (last lines):\nassertion failed');
  rows.push({ id: 'a3', flowId: 'f', step: 'other', status: 'failed' });
  assert.equal(failedChangeReason(store, 'f'), 'Change workflow failed; inspect retained attempt evidence');
  assert.equal(failedFlowNotice(store, 'f'), '');
});
