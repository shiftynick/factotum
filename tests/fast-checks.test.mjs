import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sandbox, until } from './helpers.mjs';
import { admitFlow, publicAttempt } from '../starter/factory/core/project.mjs';
import { claimCandidate } from '../starter/factory/operations/admission.mjs';
import { setTargetHealth } from '../starter/factory/operations/targets.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { changeWorkflow, documentWorkflow, validateConfig } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { compileCatalog } from '../starter/factory/core/catalog.mjs';

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'starter', 'project', 'integrations', 'fast-check.example.mjs');
const RULE = 'The change updates its verify step when it changes behaviour';

// A fictional check script outside the checkout: reads its mode from a file so one commissioned
// definition can pass, fail, hold or hang without recommissioning.
function checkScript(dir) {
  const path = join(dir, 'rule-check.mjs'), mode = join(dir, 'mode.txt');
  writeFileSync(mode, 'pass');
  writeFileSync(path, `import {readFileSync,writeFileSync} from 'node:fs';
const mode=readFileSync(${JSON.stringify(mode)},'utf8').trim();
if(process.env.FACTOTUM_CHECK_KIND!=='fast'){console.error('not a fast check');process.exit(2);}
if(mode==='pass'){console.log('rules hold');process.exit(0);}
if(mode==='fail'){writeFileSync(process.env.FACTOTUM_CHECK_DIAGNOSTICS,'RULE verify-step: src/app.txt changed but verify.sh was not updated');console.log('1 rule violated');process.exit(1);}
if(mode==='prerequisite'){console.error('Fixture data missing; an operator must restore it');process.exit(78);}
if(mode==='touch'){writeFileSync('stray.txt','changed');process.exit(0);}
setTimeout(()=>{},60000);`);
  return { argv: [process.execPath, path], setMode: value => writeFileSync(mode, value) };
}

function fixture(t, { heavy, rules = [RULE], custom, check = {} } = {}) {
  const f = sandbox(t), bin = join(f.base, 'bin'), checks = join(f.base, 'checks');
  mkdirSync(bin); mkdirSync(checks);
  const gh = join(bin, 'gh'); writeFileSync(gh, `#!${process.execPath}\nif(process.argv[2]==='auth')console.log('fictional-token');else process.exit(1);\n`); chmodSync(gh, 0o755);
  const script = checkScript(checks);
  const fastChecks = { checks: [{ id: 'verify-step', argv: script.argv, timeoutMs: 2000, holdExitCodes: [78], rules, ...check }], ...(heavy ? { heavy: true } : {}) };
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath: gh }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { mainProbeMs: 0 }, fastChecks };
  if (custom) {
    // A project-owned graph that names its steps differently.
    const graph = changeWorkflow(config), nodes = graph.nodes;
    nodes['house-rules'] = { ...nodes['fast-check'], resultEdges: { pass: 'publish', fail: 'implement' } }; delete nodes['fast-check'];
    nodes.implement = nodes.build; delete nodes.build;
    for (const node of Object.values(nodes)) {
      for (const field of ['next', 'onFailure']) { if (node[field] === 'fast-check') node[field] = 'house-rules'; if (node[field] === 'build') node[field] = 'implement'; }
      for (const map of [node.resultEdges, node.answers]) for (const [k, v] of Object.entries(map ?? {})) { if (v === 'fast-check') map[k] = 'house-rules'; if (v === 'build') map[k] = 'implement'; }
    }
    mkdirSync(join(f.root, 'project', 'workflows'), { recursive: true }); writeFileSync(join(f.root, 'project', 'workflows', 'change.json'), JSON.stringify(graph));
    execFileSync('git', ['add', '.'], { cwd: f.root }); execFileSync('git', ['commit', '-qm', 'Fictional project graph'], { cwd: f.root });
    config.workflows = { definitions: { change: { path: 'project/workflows/change.json' } }, selection: { default: 'change' } };
  }
  const update = f.command('config.update', { config, note: 'Commission fictional fast checks' });
  assert.equal(update.status, 'completed', JSON.stringify(update));
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', { status: 'green', head: 'a'.repeat(40), checkedAt: new Date().toISOString() });
  assert.equal(f.command('task.approve', { taskId: 'task-1', revision: f.store.need('task', 'task-1').revision, queue: true }).status, 'completed');
  const flow = claimCandidate(f.store, { admit: (task, s) => admitFlow(s, task, { revision: task.revision }) });
  assert.ok(flow);
  return { ...f, script, flowId: flow.id, steps: { fast: custom ? 'house-rules' : 'fast-check', build: custom ? 'implement' : 'build' } };
}
// Position the admitted flow at a step, as the earlier graph steps would have left it.
function place(f, step, extra = {}) {
  const flow = f.store.need('flow', f.flowId);
  Object.assign(flow, { step, state: 'ready', attemptId: null, results: { ...flow.results, integrate: { base: repositoryIdentity(f.root).head, route: 'integrated' } }, ...extra });
  f.store.put('flow', flow);
}
// Prepare, dispatch and settle one real attempt of the current step.
async function runStep(f) {
  const step = f.store.need('flow', f.flowId).step;
  await f.engine.step(f.flowId);
  const attemptId = f.store.need('flow', f.flowId).attemptId; assert.ok(attemptId, `no attempt prepared at ${step}`);
  await until(() => f.store.need('attempt', attemptId).settledAt, { tick: () => f.engine.step(f.flowId) });
  return f.store.need('attempt', attemptId);
}
// The prompt one provider step would send, through the real dispatch path.
async function prompt(f, step) {
  const flow = f.store.need('flow', f.flowId), node = flow.workflow.nodes[step], artifactDir = join(f.base, 'prompt', step);
  mkdirSync(artifactDir, { recursive: true });
  const spec = actionSpecification(f.store, { ...flow, step }, node, artifactDir);
  let sent;
  await assert.rejects(runAction({ attemptId: 'prompt', cwd: spec.cwd, projectRoot: f.root, timeoutMs: 120000, action: spec.action }, { providerInvoke: async route => { sent = route; throw new Error('fixture stops after the prompt'); } }), /fixture stops after the prompt/);
  return sent.prompt;
}

test('a passing fast check moves the exact candidate on to review, records only a named observation, and tells the reviewer which rules it owns', async t => {
  const f = fixture(t); place(f, 'fast-check');
  const attempt = await runStep(f), flow = f.store.need('flow', f.flowId), identity = repositoryIdentity(f.root);
  assert.equal(attempt.status, 'passed'); assert.equal(flow.step, 'publish');
  const result = flow.results['fast-check'];
  assert.equal(result.route, 'pass'); assert.deepEqual(result.inputIdentity, identity); assert.equal(result.checkDefinitionDigest, digest(f.store.meta('config').fastChecks)); assert.equal(result.checks[0].status, 'passed');
  assert.equal(flow.evidence['fast-check:passed'].head, identity.head); assert.equal(flow.evidence.gate, undefined, 'fast checks never mint gate evidence');
  const review = await prompt(f, 'review');
  assert.match(review, /fast checks passed on this exact candidate/); assert.ok(review.includes(`[verify-step] ${RULE}`)); assert.match(review, /Do not raise a finding whose only basis is one of these rules/);
});

test('a product failure returns to the builder with bounded diagnostics, without a review or gate evidence', async t => {
  const f = fixture(t); place(f, 'fast-check'); f.script.setMode('fail');
  const attempt = await runStep(f), flow = f.store.need('flow', f.flowId);
  assert.equal(attempt.status, 'passed'); assert.equal(flow.step, 'build'); assert.equal(flow.visits.build, 1);
  const check = flow.results['fast-check'].checks[0];
  assert.equal(flow.results['fast-check'].route, 'fail'); assert.equal(check.failureClass, 'product'); assert.match(check.diagnostics.detail, /verify\.sh was not updated/); assert.match(check.diagnostics.stdout, /1 rule violated/);
  assert.equal(flow.evidence.gate, undefined); assert.equal(flow.evidence['fast-check:passed'], undefined);
  assert.equal(f.store.all('attempt').filter(a => a.intent.action?.operation === 'provider.review').length, 0, 'no review ran');
  const build = await prompt(f, 'build');
  assert.match(build, /Fast checks failed on this exact candidate/); assert.match(build, /verify\.sh was not updated/);
  // The builder returning the same candidate stops for guidance instead of repeating the checks.
  await f.engine.step(f.flowId); const prepared = f.store.need('attempt', f.store.need('flow', f.flowId).attemptId);
  f.engine.settle(f.flowId, prepared, { exitCode: 0, costMicros: 0, actionResult: { route: 'implemented', result: { status: 'implemented', questions: [] } } });
  const held = f.store.need('flow', f.flowId);
  assert.equal(held.state, 'stopped'); assert.equal(held.resumeStep, 'build'); assert.match(held.stopReason, /unchanged candidate after fast checks failed/);
});

test('a failed fast check settles as a run that reported a failure: status passed, outcome failed, routed to the builder', async t => {
  const f = fixture(t); place(f, 'fast-check'); f.script.setMode('fail');
  const attempt = await runStep(f), flow = f.store.need('flow', f.flowId);
  // Lifecycle and routing are unchanged: the effect ran cleanly and the flow went back to build.
  assert.equal(attempt.status, 'passed'); assert.equal(flow.step, 'build'); assert.notEqual(flow.state, 'failed');
  // The failure is recorded on the attempt itself, beside the status.
  assert.equal(attempt.outcome, 'failed'); assert.deepEqual(attempt.failedChecks, [{ id: 'verify-step', status: 'failed', failureClass: 'product' }]);
  const view = publicAttempt(attempt);
  assert.equal(view.outcome, 'failed'); assert.equal(view.route, 'fail'); assert.equal(view.operation, 'fastCheck'); assert.equal(view.intent, undefined);
  // A passing run records no outcome.
  place(f, 'fast-check'); f.script.setMode('pass');
  const passing = await runStep(f);
  assert.equal(passing.status, 'passed'); assert.equal(passing.outcome, undefined); assert.equal(publicAttempt(passing).outcome, undefined);
});

test('fast-check output from another candidate or check definition is not presented as current', async t => {
  const f = fixture(t); place(f, 'fast-check'); f.script.setMode('fail'); await runStep(f);
  assert.match(await prompt(f, 'build'), /Fast checks failed on this exact candidate/);
  // The candidate moved on (a later correction): the earlier failure is not current correction work.
  writeFileSync(join(f.root, 'input.txt'), 'corrected\n'); execFileSync('git', ['commit', '-qam', 'Fictional correction'], { cwd: f.root });
  assert.doesNotMatch(await prompt(f, 'build'), /Fast checks failed/);
  // A pass on an older candidate does not exempt rules for the reviewer either.
  place(f, 'fast-check'); f.script.setMode('pass'); await runStep(f);
  assert.match(await prompt(f, 'review'), /fast checks passed on this exact candidate/);
  writeFileSync(join(f.root, 'input.txt'), 'later\n'); execFileSync('git', ['commit', '-qam', 'Fictional later change'], { cwd: f.root });
  assert.doesNotMatch(await prompt(f, 'review'), /fast checks passed/);
  // Changed check definitions: a result produced under the old ones is stale.
  place(f, 'fast-check'); await runStep(f);
  const config = structuredClone(f.store.meta('config')); config.fastChecks.checks[0].timeoutMs = 3000; f.store.setMeta('config', validateConfig(config));
  assert.doesNotMatch(await prompt(f, 'review'), /fast checks passed/);
});

test('a reserved prerequisite exit holds the flow at the fast check without a builder visit', async t => {
  const f = fixture(t); place(f, 'fast-check'); f.script.setMode('prerequisite');
  const attempt = await runStep(f), flow = f.store.need('flow', f.flowId);
  assert.equal(attempt.status, 'failed'); assert.equal(flow.state, 'stopped'); assert.equal(flow.resumeStep, 'fast-check'); assert.equal(flow.visits.build ?? 0, 0);
  assert.equal(flow.results['fast-check'].fastCheckHold.kind, 'check-prerequisite'); assert.match(flow.stopReason, /verify-step \(exit 78\).*builder was not retried/);
  assert.match(flow.results['fast-check'].checks[0].diagnostics.stderr, /Fixture data missing/);
  assert.equal(flow.evidence.gate, undefined);
  // A replan supersedes the earlier cycle's fast-check result like a gate result.
  assert.equal(f.command('flow.replan', { flowId: f.flowId, note: 'Restore fixture data, then plan again' }).status, 'completed');
  const replanned = f.store.need('flow', f.flowId);
  assert.equal(replanned.results['fast-check'], undefined); assert.deepEqual(f.store.events(20).find(e => e.type === 'flow.replan').payload.supersededGateResults, ['fast-check']);
});

test('a fast check that cannot finish is an infrastructure hold, and one that edits the candidate fails the step', async t => {
  const f = fixture(t); place(f, 'fast-check'); f.script.setMode('hang');
  await runStep(f); let flow = f.store.need('flow', f.flowId);
  assert.equal(flow.state, 'stopped'); assert.equal(flow.resumeStep, 'fast-check'); assert.equal(flow.results['fast-check'].fastCheckHold.kind, 'infrastructure'); assert.match(flow.stopReason, /timed out or could not start/); assert.equal(flow.visits.build ?? 0, 0);
  const g = fixture(t); place(g, 'fast-check'); g.script.setMode('touch');
  const attempt = await runStep(g); flow = g.store.need('flow', g.flowId);
  assert.equal(attempt.status, 'failed'); assert.equal(flow.step, 'failed'); assert.match(flow.results['fast-check'].reason, /must not edit the tree/);
});

test('repeated fast-check failures exhaust the existing build budget and stop with the reason', async t => {
  const f = fixture(t); place(f, 'fast-check', { visits: { ...f.store.need('flow', f.flowId).visits, build: 4 } }); f.script.setMode('fail');
  await runStep(f); const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.state, 'stopped'); assert.equal(flow.step, 'fast-check'); assert.equal(flow.resumeStep, 'build'); assert.match(flow.stopReason, /workflow visit bound exhausted at build/);
});

test('a project-owned graph with its own step names runs fast checks and routes failures to its builder', async t => {
  const f = fixture(t, { custom: true }); assert.equal(f.store.need('flow', f.flowId).workflowName, 'change');
  place(f, 'house-rules'); f.script.setMode('fail');
  await runStep(f); const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.step, 'implement'); assert.equal(flow.results['house-rules'].route, 'fail'); assert.equal(flow.results['fast-check'].route, 'fail');
  assert.match(await prompt(f, 'implement'), /verify\.sh was not updated/);
});

test('a heavy fast check waits a bounded time for the shared permit and holds, naming the holder', async t => {
  const f = fixture(t, { heavy: true }), coordinatorPath = join(f.base, 'resources.sqlite');
  const config = structuredClone(f.store.meta('config')); config.resources = { coordinatorPath }; f.store.setMeta('config', validateConfig(config));
  const { HostResources } = await import('../starter/factory/operations/resources.mjs'), { processIdentity } = await import('../starter/factory/core/process-identity.mjs');
  const other = new HostResources(coordinatorPath); t.after(() => other.close());
  assert.ok(other.acquire({ projectId: 'other-project', flowId: 'other-flow', attemptId: 'other-attempt', owner: processIdentity() }));
  place(f, 'fast-check'); const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.workflow.nodes['fast-check'].heavy, true);
  await f.engine.step(f.flowId); const attempt = f.store.need('attempt', f.store.need('flow', f.flowId).attemptId);
  assert.equal(attempt.intent.action.resource, true);
  // The real dispatch under a contained owner identity, with a short effect bound.
  const artifactDir = join(f.base, 'heavy'); mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, 'owner.json'), JSON.stringify({ ...processIdentity(), attemptId: attempt.id, intentDigest: attempt.intentDigest, cgroup: '/sys/fs/cgroup/fictional' }));
  const result = await runAction({ ...attempt.intent, timeoutMs: 2000, action: { ...attempt.intent.action, artifactDir } });
  assert.equal(result.route, 'held'); assert.equal(result.fastCheckHold.kind, 'resource-wait'); assert.match(result.reason, /other-project, flow other-flow/); assert.deepEqual(result.checks, []);
  assert.equal(existsSync(join(artifactDir, 'fast-check-0.json')), false, 'no check ran without the permit');
  f.engine.settle(f.flowId, attempt, { exitCode: 0, costMicros: 0, actionResult: result });
  const held = f.store.need('flow', f.flowId);
  assert.equal(held.state, 'stopped'); assert.equal(held.resumeStep, 'fast-check'); assert.match(held.stopReason, /heavy-work permit is free/); assert.equal(held.visits.build ?? 0, 0);
});

test('configuration bounds fast checks, and graphs cannot make them gate evidence or let failures fall through', t => {
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }] };
  const fast = checks => ({ ...base, fastChecks: { checks } }), ok = { id: 'rules', argv: ['true'], timeoutMs: 1000 };
  for (const bad of [[], [{ ...ok, timeoutMs: 300001 }], [ok, ok], [{ ...ok, holdExitCodes: [0] }], [{ ...ok, rules: ['two\nlines'] }], [{ ...ok, extra: true }], Array.from({ length: 3 }, (_, i) => ({ ...ok, id: `r${i}`, timeoutMs: 250000 }))]) assert.throws(() => validateConfig(fast(bad)));
  assert.throws(() => validateConfig({ ...base, fastChecks: { checks: [ok], heavy: 'yes' } }));
  validateConfig(fast([ok]));
  // Without fastChecks the reference graphs are exactly the ones commissioned before.
  const plain = changeWorkflow(base), withFast = changeWorkflow(fast([ok]));
  assert.ok(!Object.values(plain.nodes).some(node => node.action?.operation === 'fastCheck')); assert.equal(plain.nodes.integrate.resultEdges.integrated, 'publish');
  const { 'fast-check': node, ...rest } = withFast.nodes;
  assert.deepEqual({ ...withFast, maxTransitions: withFast.maxTransitions - 20, nodes: { ...rest, integrate: { ...rest.integrate, next: 'publish', resultEdges: { ...rest.integrate.resultEdges, integrated: 'publish' } } } }, plain);
  assert.equal(node.resultEdges.fail, 'build'); assert.equal(node.heavy, undefined); assert.equal(node.evidence, 'fast-check:passed');
  assert.deepEqual(documentWorkflow(fast([ok])), documentWorkflow(base), 'document flows run no checks');
  // Project graphs: explicit pass/fail routes, never gate evidence, and only with configured checks.
  const root = execFileSync('mktemp', ['-d']).toString().trim(); t.after(() => execFileSync('rm', ['-rf', root]));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const commission = (graph, config) => { mkdirSync(join(root, 'p'), { recursive: true }); writeFileSync(join(root, 'p', 'g.json'), JSON.stringify(graph)); return () => compileCatalog({ ...config, workflows: { definitions: { g: { path: 'p/g.json' } }, selection: { default: 'g' } } }, root); };
  const variant = change => { const graph = structuredClone(withFast); change(graph.nodes['fast-check']); return graph; };
  assert.throws(commission(variant(n => { delete n.resultEdges.fail; }), fast([ok])), /must route pass and fail explicitly/);
  assert.throws(commission(variant(n => { n.evidence = 'gate'; }), fast([ok])), /cannot mint gate evidence/);
  assert.throws(commission(withFast, base), /no fastChecks are configured/);
  commission(withFast, fast([ok]))();
});

test('the starter example fast check enforces its rule, reports it, and reserves a prerequisite exit', async t => {
  const f = sandbox(t), root = f.root, remote = join(f.base, 'remote.git'), artifacts = join(f.base, 'artifacts'); mkdirSync(artifacts);
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const config = { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, checks: [], fastChecks: { checks: [{ id: 'tests-with-source', argv: [process.execPath, EXAMPLE], timeoutMs: 30000, holdExitCodes: [78] }] } };
  const run = () => runAction({ attemptId: 'example', cwd: root, projectRoot: root, timeoutMs: 60000, action: { operation: 'fastCheck', task: { id: 'task-1', title: 'Fictional', acceptance: ['Works'] }, config, context: { files: [] }, artifactDir: artifacts, results: {}, sessions: {}, target: 'main' } });
  git(['branch', '-M', 'main']);
  let result = await run(); assert.equal(result.route, 'held'); assert.equal(result.checks[0].exitCode, 78, 'no target ref is a prerequisite, not a builder failure');
  git(['init', '-q', '--bare', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'app.txt'), 'behaviour\n'); git(['add', '.']); git(['commit', '-qm', 'Fictional source change']);
  result = await run(); assert.equal(result.route, 'fail'); assert.match(result.checks[0].diagnostics.detail, /src\/app\.txt/);
  mkdirSync(join(root, 'test')); writeFileSync(join(root, 'test', 'app.test.txt'), 'covers behaviour\n'); git(['add', '.']); git(['commit', '-qm', 'Fictional test change']);
  result = await run(); assert.equal(result.route, 'pass');
  assert.ok(readFileSync(EXAMPLE, 'utf8').includes("stdio: ['ignore'"), 'the example spawns children with stdin ignored');
});

test('a check run through git keeps its timeout and check environment, and gets no factory Git credentials', async t => {
  // Seen in review: argv[0] "git" was routed to the factory's credential-scoped Git helper, which
  // dropped the check's timeout, signal, output bound and environment.
  const out = join(tmpdirFor(t), 'kind.txt');
  const o = JSON.stringify(out).slice(1, -1);
  const f = fixture(t, { check: { argv: ['git', '-c', `alias.kind=!printenv FACTOTUM_CHECK_KIND > ${o}; git config core.hooksPath >> ${o}; git config maintenance.auto >> ${o}; printenv GIT_CONFIG_GLOBAL >> ${o}; printenv FACTOTUM_GIT_TOKEN >> ${o} || true`, 'kind'] } });
  place(f, 'fast-check');
  await runStep(f);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), ['fast', '/dev/null', 'false', '/dev/null'],
    'the check environment reaches a git-launched check with hooks, maintenance and global config suppressed, and no factory Git token');
  const g = fixture(t, { check: { argv: ['git', '-c', 'alias.slow=!sleep 5', 'slow'], timeoutMs: 200 } });
  place(g, 'fast-check');
  await runStep(g);
  const flow = g.store.need('flow', g.flowId);
  assert.equal(flow.state, 'stopped'); assert.equal(flow.results['fast-check'].fastCheckHold.kind, 'infrastructure', 'the 200 ms bound applies to a git-launched check');
});
function tmpdirFor(t) { const dir = join(execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim()); t.after(() => execFileSync('rm', ['-rf', dir])); return dir; }

test('a check whose output overflows the bound is an infrastructure hold, not a builder failure', async t => {
  const f = fixture(t, { check: { argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(3*1024*1024))"] } });
  place(f, 'fast-check');
  await runStep(f);
  const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.state, 'stopped'); assert.equal(flow.results['fast-check'].fastCheckHold.kind, 'infrastructure'); assert.equal(flow.visits.build ?? 0, 0);
});
