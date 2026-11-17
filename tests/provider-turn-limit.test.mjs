// dev.84 H9: a model step whose provider stopped at its turn limit. Claude's error_max_turns is a
// known end (MAX_TURNS), not an uncertain one; a builder out of turns goes to the build question
// with the reviewed plan kept and a retry that resumes its session; a planner or reviewer out of
// turns is settled as failed and the flow stops at the same step; builds get a larger default
// limit, configurable per role and per step; and settling an uncertain attempt is preceded by a
// warning when resume would then fail the flow. See docs/changes/dev84-flow-fixes.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { createProviderAdapter } from '../starter/factory/adapters/providers/index.mjs';
import { defaultMaxTurns } from '../starter/factory/adapters/providers/routes.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { validateConfig, changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { selectFlowModels } from '../starter/factory/operations/model-settings.mjs';
import { setTargetHealth } from '../starter/factory/operations/targets.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { executeCommand, publicAttempt, recoveredFailures } from '../starter/factory/core/project.mjs';
import { attemptOutcome } from '../starter/factory/core/attempt-outcome.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { flowNeedsAttention } from '../starter/factory/operations/notifications.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { assembleContext } from '../starter/factory/operations/context.mjs';

const session = '00000000-0000-0000-0000-000000000017';
const help = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
// A fictional Claude CLI: version, help and subscription status, then the given stream.
function claude(events) {
  const calls = [];
  const transport = async (binary, args) => {
    calls.push(args);
    if (args.includes('--version')) return { code: 0, stdout: '2.1.323', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
    return { code: 1, stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: '' };
  };
  return { adapter: createProviderAdapter({ transport, environment: { HOME: '/fictional', PATH: '/usr/bin' } }), calls };
}
const usage = { input_tokens: 40, output_tokens: 20 };
const maxTurnsEnd = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 17, total_cost_usd: 0.856, session_id: session, usage };
async function spec(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-limit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return { provider: 'claude', model: 'claude-opus-5-5', role: 'builder', prompt: 'Fictional build', cwd: dir, artifactDir: join(dir, 'private'), timeoutMs: 60000, maxTurns: 16, ...extra };
}

// ---- The adapter ----

test('H9: Claude ending with error_max_turns is a known turn-limit end with its turns, limit and cost, not an invalid result', async t => {
  const { adapter, calls } = claude([{ type: 'system', subtype: 'init', session_id: session }, maxTurnsEnd]);
  await assert.rejects(adapter.invoke(await spec(t)), error => {
    assert.equal(error.code, 'MAX_TURNS'); assert.equal(error.started, true);
    assert.deepEqual(error.turnLimit, { provider: 'claude', model: 'claude-opus-5-5', subtype: 'error_max_turns', turns: 17, costUsd: 0.856, sessionId: session, maxTurns: 16 });
    assert.equal(error.message, 'claude stopped at its turn limit (error_max_turns, after 17 turns, limit 16, reported cost $0.856); the step did not finish and returned no result');
    assert.deepEqual(error.accountingResult.usage, usage, 'the usage is still accounted');
    return true;
  });
  const run = calls.at(-1); assert.equal(run[run.indexOf('--max-turns') + 1], '16');
});

test('H9: another unsuccessful Claude end names its subtype and turns instead of only "inspect private artifacts"', async t => {
  const { adapter } = claude([{ ...maxTurnsEnd, subtype: 'error_during_execution', num_turns: 5, total_cost_usd: 0.12 }]);
  await assert.rejects(adapter.invoke(await spec(t)), error => {
    assert.equal(error.code, 'INVALID_RESULT');
    assert.equal(error.message, "Provider did not produce a complete validated result; inspect private artifacts (claude ended with error_during_execution after 5 turns, reported cost $0.120; its output is in the attempt's provider stdout.jsonl)");
    return true;
  });
});

// ---- Dispatch: the default limit, and the builder's result ----

const buildIntent = (cwd, operation = 'provider.build', extra = {}) => ({ attemptId: uid(), cwd, projectRoot: cwd, timeoutMs: 600000, action: { operation, step: operation === 'provider.build' ? 'build' : 'plan-review', stateDir: join(cwd, '.state'), projectId: 'project-1', flowId: 'flow-1',
  task: { id: 'task-1', title: 'Fictional change', acceptance: ['Works'], revision: 'r1', risk: 'strict' }, context: { files: [], digest: 'context' }, artifactDir: join(cwd, '.artifacts'), sessions: {},
  config: { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'claude-opus-5-5' }, builder: { provider: 'claude', model: 'claude-opus-5-5' }, reviewer: { provider: 'claude', model: 'claude-opus-5-5' } }, checks: [{ id: 'check', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 24000 } },
  results: { plan: { route: 'ready', result: { status: 'ready', summary: 'Fictional reviewed plan' } } }, ...extra } });
const outOfTurns = spec => { const error = Object.assign(new Error('claude stopped at its turn limit'), { code: 'MAX_TURNS', started: true, turnLimit: { provider: 'claude', model: spec.model, subtype: 'error_max_turns', turns: 17, costUsd: 0.856, sessionId: session, maxTurns: spec.maxTurns } }); error.accountingResult = { provider: 'claude', model: spec.model, sessionId: session, usage }; return error; };

test('review fix 1: a turn-limit end in a session not bound to the invocation, or without one, stays an uncertain invalid result', async t => {
  const other = '00000000-0000-0000-0000-0000000000bb';
  // Repro 1: the invocation resumes session A (`session`); the error_max_turns result names session B.
  let probe = claude([maxTurnsEnd].map(event => ({ ...event, session_id: other })));
  await assert.rejects(probe.adapter.invoke(await spec(t, { sessionId: session })), error => {
    assert.equal(error.code, 'INVALID_RESULT'); assert.equal(error.started, true); assert.equal(error.turnLimit, undefined);
    assert.match(error.message, /ended with error_max_turns after 17 turns, reported cost \$0\.856, in a session other than the one this invocation resumed/);
    assert.equal(error.accountingResult.sessionId, session, 'accounting keeps the invocation’s own session, never B');
    return true;
  });
  // Repro 2: the result names no session at all.
  const { session_id, ...unnamed } = maxTurnsEnd;
  probe = claude([unnamed]);
  await assert.rejects(probe.adapter.invoke(await spec(t)), error => {
    assert.equal(error.code, 'INVALID_RESULT'); assert.equal(error.turnLimit, undefined);
    assert.match(error.message, /ended with error_max_turns after 17 turns, reported cost \$0\.856, without a session/);
    return true;
  });
  // The same session as the one resumed is bound.
  probe = claude([maxTurnsEnd]);
  await assert.rejects(probe.adapter.invoke(await spec(t, { sessionId: session })), error => error.code === 'MAX_TURNS' && error.turnLimit.sessionId === session);
  // Dispatch checks again before a builder's session is kept: an unbound or missing session is not a blocked build.
  const f = sandbox(t);
  for (const sessionId of [other, null]) {
    const intent = buildIntent(f.root); intent.action.sessions = { builder: session }; intent.action.results.build = { provider: 'claude', model: 'claude-opus-5-5', sessionId: session };
    await assert.rejects(runAction(intent, { providerInvoke: async spec => { const error = outOfTurns(spec); error.turnLimit.sessionId = sessionId; throw error; } }), error => {
      assert.equal(error.code, 'INVALID_RESULT'); assert.equal(error.turnLimit, undefined); assert.equal(error.notice, undefined); return true;
    });
  }
});

test('H9: builds get a larger default turn limit than planners and reviewers; a configured limit wins', async t => {
  assert.equal(defaultMaxTurns('builder'), 60); assert.equal(defaultMaxTurns('planner'), 16); assert.equal(defaultMaxTurns('reviewer'), 16);
  const f = sandbox(t), seen = [];
  const providerInvoke = async spec => { seen.push(spec.maxTurns); throw outOfTurns(spec); };
  await runAction(buildIntent(f.root), { providerInvoke });
  const configured = buildIntent(f.root); configured.action.config.providers.builder.maxTurns = 90;
  await runAction(configured, { providerInvoke });
  assert.deepEqual(seen, [60, 90]);
});

test('H9: a builder out of turns returns a blocked build with the turn limit, its session and the notice', async t => {
  const f = sandbox(t);
  const result = await runAction(buildIntent(f.root), { providerInvoke: async spec => { throw outOfTurns(spec); } });
  assert.equal(result.route, 'blocked'); assert.equal(result.sessionId, session); assert.equal(result.provider, 'claude'); assert.equal(result.model, 'claude-opus-5-5');
  assert.deepEqual(result.turnLimit, { provider: 'claude', model: 'claude-opus-5-5', subtype: 'error_max_turns', turns: 17, costUsd: 0.856, sessionId: session, maxTurns: 60, role: 'builder', step: 'build', artifact: 'provider/stdout.jsonl' });
  assert.equal(result.notice, "The builder (claude claude-opus-5-5) stopped at its turn limit at step build: error_max_turns, after 17 turns, limit 60, reported cost $0.856. Its output is in the attempt's provider/stdout.jsonl. Nothing was committed; its edits so far stay in the worktree, and the reviewed plan is kept.");
  assert.deepEqual(result.providerInvocations.map(row => row.usage), [usage], 'the cost is accounted');
  // A reviewer out of turns is an error for the step, carrying the same facts and its own notice.
  await assert.rejects(runAction(buildIntent(f.root, 'provider.planReview'), { providerInvoke: async spec => { throw outOfTurns(spec); } }), error => {
    assert.equal(error.code, 'MAX_TURNS'); assert.equal(error.turnLimit.role, 'reviewer'); assert.equal(error.turnLimit.maxTurns, 16);
    assert.match(error.notice, /^The reviewer \(claude claude-opus-5-5\) stopped at its turn limit at step plan-review: error_max_turns, after 17 turns, limit 16, reported cost \$0\.856\. .* It is read-only, so nothing changed; the attempt is settled as failed \(turn-limit\) and the flow stopped at plan-review\. Resume runs the step again with the same limit; to give it more turns, raise providers\.reviewer\.maxTurns/);
    return true;
  });
});

// ---- The engine ----

const H = c => c.repeat(40), iso = () => new Date().toISOString();
const delivery = t => {
  const f = sandbox(t);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'm' }, builder: { provider: 'claude', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { mainProbeMs: 0, maxFlows: 1 } };
  assert.equal(f.command('config.update', { config, note: 'Commission fictional delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: iso() });
  const ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Fictional strict change', acceptance: ['Observed'], risk: 'strict' } }));
  ok(f.command('task.approve', { taskId: 'task-2', revision: f.store.need('task', 'task-2').revision }));
  const a = ok(f.command('flow.start', { taskId: 'task-2', revision: f.store.need('task', 'task-2').revision, flowId: 'flow-strict' })).id;
  const identity = repositoryIdentity(f.root), contextDigest = assembleContext({ repoRoot: f.root, config: config.context, changedPaths: [] }).digest;
  const plan = { route: 'ready', identity, contextDigest, taskRevision: f.store.need('task', 'task-2').revision, result: { status: 'ready', summary: 'Fictional reviewed plan', questions: [] } }, planReview = { route: 'pass', identity, result: { verdict: 'pass', summary: 'Fine', findings: [] } };
  // A flow placed directly at a later step carries the comparison commit a real one records before its model work.
  const at = (step, extra = {}) => f.store.put('flow', { ...f.store.need('flow', a), step, state: 'ready', attemptId: null, governanceBase: identity.head, ...extra });
  const attempt = async step => { at(step, { results: { ...f.store.need('flow', a).results, plan, 'plan-review': planReview } }); await f.engine.step(a); const id = f.store.need('flow', a).attemptId; assert.ok(id, `an attempt at ${step}`); return f.store.need('attempt', id); };
  const question = () => f.store.all('inbox').find(row => row.flowId === a && row.kind === 'question' && row.status === 'open');
  return { ...f, ok, a, plan, at, attempt, question };
};

test('H9: a builder out of turns stops at the build question with the reviewed plan kept; retry resumes its session', async t => {
  const f = delivery(t), attempt = await f.attempt('build');
  const limit = { provider: 'claude', model: 'm', subtype: 'error_max_turns', turns: 17, costUsd: 0.856, sessionId: session, maxTurns: 16, role: 'builder', step: 'build', artifact: 'provider/stdout.jsonl' };
  f.engine.settle(f.a, attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'blocked', turnLimit: limit, notice: 'Fictional builder notice', provider: 'claude', model: 'm', sessionId: session, identity: repositoryIdentity(f.root) } });
  let flow = f.store.need('flow', f.a), settled = f.store.need('attempt', attempt.id);
  assert.equal(flow.step, 'build-question'); assert.notEqual(flow.state, 'failed');
  assert.deepEqual(flow.results.plan, f.plan, 'the reviewed plan is kept');
  assert.equal(flow.sessions.builder, session);
  assert.equal(settled.status, 'passed'); assert.equal(settled.classification, 'turn-limit'); assert.equal(settled.reason, 'provider turn limit: error_max_turns, after 17 turns, limit 16, reported cost $0.856');
  await f.engine.step(f.a);
  const item = f.question();
  assert.ok(item, 'the build question opened');
  assert.match(item.context, /^The builder ran out of turns: claude ended the build with error_max_turns after 17 turns \(limit 16\), reported cost \$0\.856\. Nothing was committed; its edits so far stay in the worktree\. The reviewed plan is kept\./);
  assert.match(item.context, /A retry resumes the same builder session with the reviewed plan and another 16 turns\. To allow more turns per build, raise providers\.builder\.maxTurns/);
  assert.deepEqual(item.choices.map(choice => [choice.id, choice.label]), [['retry', 'Retry the build'], ['stop', 'Stop flow']]);
  assert.equal(item.buildQuestion.status, 'turn-limit'); assert.equal(item.buildQuestion.turnLimit.turns, 17);
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation: 'answer', payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'retry' } });
  assert.equal(receipt.status, 'completed', receipt.error);
  flow = f.store.need('flow', f.a);
  assert.equal(flow.step, 'build'); assert.deepEqual(flow.results.plan, f.plan); assert.equal(flow.sessions.builder, session, 'the retry resumes the builder session');
});

test('dev.85 I2: a build out of turns is recorded and read as stopped at its turn limit, not passed; its lifecycle status is unchanged', async t => {
  const f = delivery(t), attempt = await f.attempt('build');
  const limit = { provider: 'claude', model: 'm', subtype: 'error_max_turns', turns: 4, costUsd: 0.294, sessionId: session, maxTurns: 3, role: 'builder', step: 'build', artifact: 'provider/stdout.jsonl' };
  f.engine.settle(f.a, attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'blocked', turnLimit: limit, notice: 'Fictional builder notice', provider: 'claude', model: 'm', sessionId: session, identity: repositoryIdentity(f.root) } });
  const settled = f.store.need('attempt', attempt.id);
  assert.equal(settled.status, 'passed', 'the lifecycle status is unchanged: the runner settled cleanly');
  assert.equal(settled.outcome, 'turn-limit', 'the routed outcome is recorded beside it');
  assert.equal(publicAttempt(settled).outcome, 'turn-limit');
  // An attempt settled before the outcome was recorded (dev.84) is read the same way from its receipt.
  const { outcome, ...legacy } = settled;
  assert.equal(publicAttempt(legacy).outcome, 'turn-limit');
  // status --flow lists it as stopped at the turn limit, not as a pass.
  const listed = stateView(f.store, { flow: f.a }).attempts.find(row => row.id === attempt.id);
  assert.equal(listed.status, 'passed'); assert.equal(listed.outcome, 'turn-limit');
  // The build question's title says what happened, not the graph's "The builder is blocked".
  await f.engine.step(f.a);
  const item = f.question();
  assert.equal(item.question, 'The builder stopped at its turn limit before the build finished. Retry continues it with the reviewed plan.');
  // A flow that went on to finish is not routine, and its completion notice says the build stopped at the limit on the way.
  const flow = f.store.need('flow', f.a);
  assert.equal(flowNeedsAttention(f.store, { ...flow, results: {} }, 'completed'), true);
  assert.deepEqual(recoveredFailures(f.store, flow, 'turn-limit'), ['build stopped at its provider turn limit once']);
  assert.deepEqual(recoveredFailures(f.store, flow), [], 'it is not counted as a reported failure');
  // A failed fast check keeps its own outcome; a reviewer's failed turn-limit attempt has no derived outcome (its status is failed).
  assert.deepEqual(attemptOutcome('passed', { route: 'fail', checks: [{ id: 'c', status: 'failed' }] }), { outcome: 'failed', failedChecks: [{ id: 'c', status: 'failed' }] });
  assert.equal(attemptOutcome('failed', { route: 'error', turnLimit: limit }), null);
});

test('H9: a reviewer out of turns is settled as failed and the flow stops at the same step, not on its failure route', async t => {
  const f = delivery(t), earlier = { route: 'revise', result: { verdict: 'revise', summary: 'Earlier review', findings: [] } };
  f.at('review', { results: { plan: f.plan, review: earlier } });
  await f.engine.step(f.a);
  const attempt = f.store.need('attempt', f.store.need('flow', f.a).attemptId);
  const limit = { provider: 'claude', model: 'm', subtype: 'error_max_turns', turns: 17, costUsd: 0.4, sessionId: session, maxTurns: 16, role: 'reviewer', step: 'review' };
  f.engine.settle(f.a, attempt, { exitCode: 1, costMicros: 0, actionResult: { route: 'error', error: 'claude stopped at its turn limit', notice: 'Fictional reviewer turn-limit notice', turnLimit: limit } });
  const flow = f.store.need('flow', f.a), settled = f.store.need('attempt', attempt.id);
  assert.equal(flow.state, 'stopped', 'not failed'); assert.equal(flow.resumeStep, 'review'); assert.equal(flow.stopReason, 'Fictional reviewer turn-limit notice');
  assert.equal(settled.status, 'failed'); assert.equal(settled.classification, 'turn-limit'); assert.deepEqual(settled.turnLimit, limit);
  assert.deepEqual(flow.results.review, earlier, 'the step’s earlier result is not overwritten');
  assert.equal(f.store.events(50).filter(event => event.type === 'flow.turn-limit-held').length, 1);
  // Resume runs the same step again.
  assert.equal(f.ok(f.command('resume', { flowId: f.a, note: 'Fictional resume' })).step, 'review');
});

test('H9: before an uncertain build is settled, the stop notice and the resume refusal say that resume would then fail the flow', async t => {
  const f = delivery(t), attempt = await f.attempt('build');
  f.engine.uncertain(attempt, 'Provider did not produce a complete validated result; inspect private artifacts');
  const warning = "Settling it (attempt.resolve, failed or not-dispatched) makes resume follow step build's failure route to failed: the flow ends failed and its reviewed plan is not reused, so the task needs a new flow (task.restart)";
  let flow = f.store.need('flow', f.a);
  assert.equal(flow.stopReason, `uncertain attempt: Provider did not produce a complete validated result; inspect private artifacts. ${warning}`);
  const refused = f.command('resume', { flowId: f.a, note: 'Fictional resume' });
  assert.equal(refused.status, 'rejected'); assert.ok(refused.error.endsWith(` Then resume. ${warning}.`), refused.error);
  f.ok(f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Fictional inspection', quiescence: 'independently-confirmed' }));
  flow = f.store.need('flow', f.a);
  assert.equal(flow.stopReason, "the operator reconciled an uncertain attempt. Resume will follow step build's failure route to failed: the flow ends failed and its reviewed plan is not reused, so the task needs a new flow (task.restart)");
});

test('H9: the warning names a failure route that does not end the flow, and is worded for after the resolve too', async () => {
  const { failureRouteWarning } = await import('../starter/factory/core/unsettled-attempt.mjs');
  const flow = { workflow: { nodes: { publish: { kind: 'effect', onFailure: 'repair' }, repair: { kind: 'question' }, done: { kind: 'end', outcome: 'completed' }, last: { kind: 'effect' } } } };
  assert.equal(failureRouteWarning(flow, 'publish'), "Settling it (attempt.resolve) makes resume follow step publish's failure route to repair");
  assert.equal(failureRouteWarning(flow, 'last'), '', 'no failure route, no warning');
  assert.equal(failureRouteWarning(flow, 'publish').replace(/^Settling it \(attempt\.resolve[^)]*\) makes resume/, 'Resume will'), "Resume will follow step publish's failure route to repair");
});

// ---- Configuration ----

test('H9: maxTurns is configurable per role and per step, within bounds', () => {
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'm' }, builder: { provider: 'claude', model: 'm', maxTurns: 80 }, reviewer: { provider: 'codex', model: 'r' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  assert.doesNotThrow(() => validateConfig(structuredClone(config)));
  for (const bad of [0, 501, 1.5, '40']) assert.throws(() => validateConfig({ ...structuredClone(config), providers: { ...config.providers, builder: { ...config.providers.builder, maxTurns: bad } } }), /providers\.builder\.maxTurns must be a whole number from 1 to 500/);
  const withStep = { ...structuredClone(config), stepModels: { standard: { build: { model: 'm', maxTurns: 120 } } } };
  assert.doesNotThrow(() => validateConfig(withStep));
  assert.throws(() => validateConfig({ ...structuredClone(config), stepModels: { standard: { build: { model: 'm', maxTurns: 0 } } } }), /stepModels\.standard\.build\.maxTurns must be a whole number from 1 to 500/);
  // The flow's pinned routes carry the limits: the step's own, else the role's.
  const routes = selectFlowModels(withStep, 'standard', changeWorkflow(withStep)).modelRoutes;
  assert.equal(routes.build.maxTurns, 120); assert.equal(routes.plan.maxTurns, undefined, 'unset: the role default applies at dispatch');
  assert.equal(selectFlowModels(config, 'standard', changeWorkflow(config)).modelRoutes.build.maxTurns, 80);
});
