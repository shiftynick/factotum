import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import * as actions from '../starter/factory/workflows/actions.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { git, prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { createGitHub } from '../starter/factory/adapters/github/index.mjs';
import { adoptionCommitCheck, observeOriginalPR, originalPRDriftText, closingReferenceHold } from '../starter/factory/workflows/adoption.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { admitFlow, executeCommand } from '../starter/factory/core/project.mjs';

const ADOPTED_MERGE_OPERATOR_ONLY = "an adopted pull request's merge question is answered by the operator only; a recorded instruction or delegated operation does not apply. The question stays open for the operator";
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { mergesInFlight, sourceWait } from '../starter/factory/operations/merge-hold.mjs';
import { setTargetHealth } from '../starter/factory/operations/targets.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';

const H = c => c.repeat(40);
const ADOPTED = H('a'), BASE = H('b'), LATER = H('c');
const ok = { sha: H('d'), commit: { message: 'Prepare docs' } };
const closing = { sha: ADOPTED, commit: { message: 'Tidy docs whitespace. Fixes #11\n\nLonger body.' } };
const rawPR = (extra = {}) => ({ number: 1, state: 'open', draft: false, merged: false, commits: 2, head: { sha: ADOPTED, ref: 'outside-branch' }, base: { sha: BASE, ref: 'main' }, html_url: 'https://example.invalid/pull/1', user: { login: 'outside-dev' }, title: 'Docs', body: '', ...extra });
// The existing fake forge transport: a function answering GitHub API paths.
function forgeWith(routes) {
  const calls = [];
  const transport = async ({ method = 'GET', path, body }) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`, value = routes[key] ?? routes[path];
    if (value instanceof Error) throw value;
    if (value === undefined) { const error = new Error(`unrouted ${key}`); error.status = 404; throw error; }
    return typeof value === 'function' ? value(body) : structuredClone(value);
  };
  return { forge: createGitHub({ repository: 'fictional/demo', account: 'fictional', transport }), calls };
}
const commitsPath = 'repos/fictional/demo/pulls/1/commits?per_page=100&page=1';

// A fake gh executable (the dispatch path builds its own forge): answers from responses.json by
// "METHOD endpoint" or endpoint, logs every call. Nothing reaches GitHub.
async function ghFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'r5-adopt-')); t.after(() => rm(directory, { recursive: true, force: true }));
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
  const respond = value => writeFile(join(bin, 'responses.json'), JSON.stringify(value));
  const calls = async () => existsSync(join(bin, 'calls.jsonl')) ? (await readFile(join(bin, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  await respond({});
  return { directory, gh, respond, calls };
}
async function repository(t, f) {
  const root = join(f.directory, 'root'), remote = join(f.directory, 'remote.git'); await mkdir(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fictional Developer']); await git(root, ['config', 'user.email', 'developer@example.invalid']);
  await writeFile(join(root, 'app.txt'), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  await git(root, ['init', '--bare', remote]); await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  return root;
}
const deliveryConfig = (gh, extra = {}) => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: gh, ...extra }, checks: [{ id: 'check', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], context: { files: [], maxChars: 24000 } });
const intentFor = (root, f, action) => ({ attemptId: uid(), cwd: root, projectRoot: root, timeoutMs: 60000, action: { stateDir: join(f.directory, 'state'), projectId: 'project-1', flowId: 'flow-1', task: { id: 'task-1', title: 'Fictional adoption', acceptance: ['Behaviour works'], revision: 'r1' }, context: { files: [], digest: 'context' }, artifactDir: join(f.directory, 'artifacts'), results: {}, sessions: {}, ...action } });

// ---- 1. Closing keywords are found at candidate, with the merge rule ----

test('adoption finds a closing keyword in an outside commit with the rule merge applies', async () => {
  const { forge } = forgeWith({ 'repos/fictional/demo/pulls/1': rawPR(), [commitsPath]: [ok, closing] });
  const check = await adoptionCommitCheck(forge, { number: 1, head: ADOPTED, base: BASE });
  assert.deepEqual(check.violations, [{ sha: ADOPTED, keyword: 'Fixes #11', title: 'Tidy docs whitespace. Fixes #11' }]);
  assert.equal(check.author, 'outside-dev');
  // The merge step refuses the same commit for the same reason.
  await assert.rejects(forge.merge({ number: 1, expectedHead: ADOPTED, expectedBase: BASE }), /GitHub closing references require explicit task disposition/);
  const hold = closingReferenceHold({ number: 1, head: ADOPTED }, check);
  assert.equal(hold.route, 'held'); assert.equal(hold.adoptionHold.kind, 'closing-reference');
  assert.match(hold.reason, /commit aaaaaaaaaaaa \("Tidy docs whitespace\. Fixes #11"\) contains "Fixes #11"/);
  assert.match(hold.reason, /ask the author to reword/); assert.match(hold.reason, /re-create the commit yourself/); assert.match(hold.reason, /flow\.abandon/);
  // Plain references are accepted.
  const plain = forgeWith({ 'repos/fictional/demo/pulls/1': rawPR(), [commitsPath]: [ok, { sha: ADOPTED, commit: { message: 'Tidy docs. Refs #11' } }] });
  assert.deepEqual((await adoptionCommitCheck(plain.forge, { number: 1, head: ADOPTED, base: BASE })).violations, []);
});

test('the candidate step stops on a closing keyword before creating a workspace', async t => {
  const f = await ghFixture(t), root = await repository(t, f);
  await f.respond({ 'repos/fictional/demo/pulls/1': rawPR(), [commitsPath]: [ok, closing] });
  const intent = intentFor(root, f, { operation: 'workspace.adopt', config: { ...deliveryConfig(f.gh), mode: undefined, version: undefined }, candidate: { number: 1, head: ADOPTED, base: BASE } });
  const result = await runAction(intent);
  assert.equal(result.route, 'held'); assert.equal(result.adoptionHold.kind, 'closing-reference'); assert.equal(result.workspace, undefined);
  assert.match(result.reason, /Fixes #11/);
  assert.equal(existsSync(join(f.directory, 'state', 'worktrees')), false, 'no owned worktree was created');
  assert.ok((await f.calls()).every(call => call.method === 'GET'), 'nothing was written to the forge');
});

test('a closing-keyword adoption hold stops the flow at candidate with a specific notice', async t => {
  const f = sandbox(t);
  const workflow = changeWorkflow({ policy: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  const candidate = { number: 1, head: ADOPTED, base: BASE };
  // The flow's adoption attempt, as the engine records it when the candidate step dispatches.
  const attempt = { id: 'adopt-attempt', flowId: 'flow-1', step: 'candidate', status: 'running', intent: { action: { operation: 'workspace.adopt' }, cwd: f.root, inputIdentity: repositoryIdentity(f.root) }, createdAt: new Date().toISOString() };
  f.store.put('attempt', attempt);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), step: 'candidate', state: 'running', candidate, attemptId: attempt.id });
  const check = { violations: [{ sha: ADOPTED, keyword: 'Fixes #11', title: 'Tidy docs whitespace. Fixes #11' }], url: 'https://example.invalid/pull/1' };
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: closingReferenceHold(candidate, check) });
  const stopped = f.store.need('flow', 'flow-1');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.step, 'candidate'); assert.equal(stopped.workspace ?? null, null); assert.equal(stopped.visits.integrate ?? 0, 0);
  assert.match(stopped.stopReason, /contains "Fixes #11".*ask the author to reword.*re-create the commit/s);
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === 'flow-1');
  assert.match(notice.context, /pull request #1 \(https:\/\/example\.invalid\/pull\/1\) cannot be delivered/);
  assert.ok(f.store.events(50).some(event => event.type === 'flow.adoption-held'));
});

// ---- 2. A push to the original PR after adoption is reported ----

test('observing the original PR lists commits pushed after adoption, and a failed read says so', async () => {
  const moved = forgeWith({ 'repos/fictional/demo/pulls/1': rawPR({ commits: 3, head: { sha: LATER, ref: 'outside-branch' } }), [commitsPath]: [ok, closing, { sha: LATER, commit: { message: 'Second outside change' } }] });
  const observation = await observeOriginalPR(moved.forge, { number: 1, head: ADOPTED });
  assert.equal(observation.status, 'moved'); assert.deepEqual(observation.commits, [{ sha: LATER, title: 'Second outside change' }]); assert.equal(observation.rewritten, false);
  const text = originalPRDriftText(observation);
  assert.match(text, /original pull request #1 \(https:\/\/example\.invalid\/pull\/1\) changed after adoption/);
  assert.match(text, /Not included: cccccccccccc Second outside change/); assert.match(text, /Do not close the original PR without handling these commits/);
  const unchanged = forgeWith({ 'repos/fictional/demo/pulls/1': rawPR() });
  assert.equal((await observeOriginalPR(unchanged.forge, { number: 1, head: ADOPTED })).status, 'unchanged');
  assert.equal(originalPRDriftText(await observeOriginalPR(unchanged.forge, { number: 1, head: ADOPTED })), '');
  const failing = forgeWith({ 'repos/fictional/demo/pulls/1': new Error('GitHub operation failed (transport)') });
  const unknown = await observeOriginalPR(failing.forge, { number: 1, head: ADOPTED });
  assert.equal(unknown.status, 'unknown'); assert.match(originalPRDriftText(unknown), /^Could not check the original pull request #1/);
  const rewritten = forgeWith({ 'repos/fictional/demo/pulls/1': rawPR({ commits: 1, head: { sha: LATER, ref: 'outside-branch' } }), [commitsPath]: [{ sha: LATER, commit: { message: 'Rewritten' } }] });
  assert.match(originalPRDriftText(await observeOriginalPR(rewritten.forge, { number: 1, head: ADOPTED })), /history was rewritten/);
});

test('the step before an adopted merge question observes the original PR; others do not', async t => {
  const graph = changeWorkflow({ policy: {} });
  assert.equal(actions.leadsToMergeQuestion?.(graph, graph.nodes.gate), true); assert.equal(actions.leadsToMergeQuestion?.(graph, graph.nodes.review), false);
  const f = await ghFixture(t), root = await repository(t, f);
  await f.respond({ 'repos/fictional/demo/pulls/1': rawPR({ commits: 3, head: { sha: LATER, ref: 'outside-branch' } }), [commitsPath]: [ok, closing, { sha: LATER, commit: { message: 'Second outside change' } }], [`POST repos/fictional/demo/statuses/${repositoryIdentity(root).head}`]: {} });
  const gate = await runAction(intentFor(root, f, { operation: 'gate', config: deliveryConfig(f.gh), candidate: { number: 1, head: ADOPTED, base: BASE }, observeOriginalPR: true }));
  assert.equal(gate.route, 'pass'); assert.equal(gate.originalPRObservation.status, 'moved'); assert.equal(gate.originalPRObservation.commits[0].sha, LATER);
  const plain = await runAction(intentFor(root, f, { operation: 'gate', config: deliveryConfig(f.gh), candidate: { number: 1, head: ADOPTED, base: BASE } }));
  assert.equal(plain.originalPRObservation, undefined);
});

async function decideFixture(t, { candidate = { number: 1, head: ADOPTED, base: BASE }, observation, policy, risk = 'ordinary', strictDecisionRole } = {}) {
  const f = sandbox(t);
  const workflow = { version: 1, start: 'check', nodes: {
    check: { kind: 'effect', argv: [process.execPath, '-e', ''], timeoutMs: 60000, next: 'decide', onFailure: 'failed' },
    decide: { kind: 'question', question: 'Merge?', role: 'operator', mergeDecision: true, answers: { merge: 'merge', stop: 'stopped' } },
    merge: { kind: 'effect', action: { operation: 'forge.merge' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' },
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  if (policy) { const config = f.store.meta('config', {}); f.store.setMeta('config', { ...config, policy: { ...config.policy, ...policy } }); }
  const task = f.store.need('task', 'task-1'); f.store.put('task', { ...task, risk });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
  const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: risk === 'strict' ? { level: 'strict', rationale: 'Access rules', threatModel: ['Fictional threat'], stopConditions: ['Fictional stop'] } : { level: 'ordinary', rationale: 'Docs change', threatModel: [], stopConditions: [] }, ...(risk === 'strict' ? { strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true } } : {}) } };
  f.store.put('flow', { ...flow, mode: 'delivery', kind: 'change', workflow, workflowDigest: digest(workflow), step: 'check', candidate, ...(strictDecisionRole ? { strictDecisionRole } : {}), mergeDecisionRole: policy?.mergeDecisionRole ?? 'operator', results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  // The step before the question settles with its observation of the original PR.
  await f.engine.step('flow-1');
  const attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'pass', ...(observation ? { originalPRObservation: observation } : {}) } });
  await f.engine.step('flow-1');
  const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.kind === 'question' && row.status === 'open');
  const answer = (actor, extra = {}, onBehalfOf) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor, operation: 'answer', payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'merge', ...extra }, ...(onBehalfOf ? { onBehalfOf } : {}) });
  return { ...f, identity, item, answer };
}
const movedObservation = { number: 1, adoptedHead: ADOPTED, checkedAt: '2026-11-15T12:00:00.000Z', url: 'https://example.invalid/pull/1', state: 'open', merged: false, head: LATER, status: 'moved', rewritten: false, commits: [{ sha: LATER, title: 'Second outside change' }], commitCount: 1 };

test('the adopted merge question names commits pushed to the original PR after adoption', async t => {
  const f = await decideFixture(t, { observation: movedObservation });
  assert.equal(f.store.need('flow', 'flow-1').originalPRObservation.status, 'moved', 'the observation is recorded on the flow');
  assert.match(f.item.context, /changed after adoption: its head moved from the adopted aaaaaaaaaaaa to cccccccccccc/);
  assert.match(f.item.context, /Not included: cccccccccccc Second outside change/); assert.match(f.item.context, /https:\/\/example\.invalid\/pull\/1/);
  assert.equal(f.item.originalPR.status, 'moved');
  const unchecked = await decideFixture(t, {});
  assert.match(unchecked.item.context, /was not checked for commits pushed after adoption/);
  const unknown = await decideFixture(t, { observation: { number: 1, adoptedHead: ADOPTED, checkedAt: '2026-11-15T12:00:00.000Z', status: 'unknown', error: 'GitHub operation failed (transport)' } });
  assert.match(unknown.item.context, /^Could not check the original pull request #1/);
});

test('completing an adopted flow whose original PR moved leaves a notice naming the commits not delivered', async t => {
  const f = await decideFixture(t, { observation: movedObservation });
  assert.equal(f.answer('operator').status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  // As the merge step leaves it: the pinned head merged, the original observed again.
  f.store.put('flow', { ...flow, step: 'done', state: 'ready', results: { ...flow.results, merge: { merged: true, expectedHead: flow.mergeAuthorization.identity.head, route: 'merged' } } });
  await f.engine.step('flow-1');
  assert.equal(f.store.need('flow', 'flow-1').state, 'completed');
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === 'flow-1' && row.outcome === 'completed');
  assert.match(notice.context, /The adopted head aaaaaaaaaaaa was merged\. The original pull request #1 .* changed after adoption/);
  assert.match(notice.context, /Not included: cccccccccccc Second outside change/);
});

test('after merge the original-pr obligation resolves when GitHub shows it merged, and stays pending with the drift otherwise', async t => {
  const f = await ghFixture(t), root = await repository(t, f);
  const run = () => runAction(intentFor(root, f, { operation: 'postMerge', config: deliveryConfig(f.gh), candidate: { number: 1, head: ADOPTED, base: BASE }, results: { candidate: { originalPR: { number: 1, url: 'https://example.invalid/pull/1' } } } }));
  await f.respond({ 'repos/fictional/demo/pulls/1': rawPR({ state: 'closed', merged: true }) });
  let result = await run(), obligation = result.obligations.find(row => row.id === 'flow-1:original-pr');
  assert.equal(obligation.status, 'passed'); assert.match(obligation.resolution, /merged/);
  await f.respond({ 'repos/fictional/demo/pulls/1': rawPR({ commits: 3, head: { sha: LATER, ref: 'outside-branch' } }), [commitsPath]: [ok, closing, { sha: LATER, commit: { message: 'Second outside change' } }] });
  result = await run(); obligation = result.obligations.find(row => row.id === 'flow-1:original-pr');
  assert.equal(obligation.status, 'pending'); assert.match(obligation.title, /do not close it without handling them/); assert.match(obligation.text, /Not included: cccccccccccc/);
  assert.equal(result.originalPRObservation.status, 'moved');
  await f.respond({});
  result = await run(); obligation = result.obligations.find(row => row.id === 'flow-1:original-pr');
  assert.equal(obligation.status, 'pending'); assert.match(obligation.text, /^Could not check/);
});

test('an automatic post-merge record does not reopen an original-pr obligation the operator already resolved', async t => {
  const f = sandbox(t); f.start();
  f.store.put('obligation', { id: 'flow-1:original-pr', flowId: 'flow-1', title: 'Original PR', status: 'passed', evidence: 'closed by the operator', resolvedAt: new Date().toISOString(), owner: 'operator' });
  await f.engine.step('flow-1');
  const attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'pass', obligations: [{ id: 'flow-1:original-pr', status: 'pending', title: 'Review and close', owner: 'operator' }, { id: 'flow-1:other', status: 'pending', title: 'Other', owner: 'operator' }] } });
  assert.equal(f.store.need('obligation', 'flow-1:original-pr').status, 'passed');
  assert.equal(f.store.need('obligation', 'flow-1:other').status, 'pending');
});

// ---- 3. The outside author is told where their commits went ----

async function publishFixture(t, repositoryExtra = {}) {
  const f = await ghFixture(t), root = await repository(t, f);
  // The integrated target and head, as the integrate step records them (forge.publish publishes only that head).
  const targetHead = repositoryIdentity(root).head;
  const workspace = await prepare({ root, stateDir: join(f.directory, 'state'), projectId: 'project-1', flowId: 'flow-1', baseRef: targetHead });
  await writeFile(join(workspace.path, 'feature.txt'), 'outside work\n'); await git(workspace.path, ['add', '.']); await git(workspace.path, ['commit', '-m', 'Outside work']);
  await f.respond({
    [`repos/fictional/demo/pulls?state=all&head=${encodeURIComponent(`fictional:${workspace.branch}`)}&per_page=100&page=1`]: [],
    'POST repos/fictional/demo/pulls': { number: 7, html_url: 'https://example.invalid/pull/7' },
    'repos/fictional/demo/issues/7/comments?per_page=100&page=1': [], 'POST repos/fictional/demo/issues/7/comments': { id: 70 },
    'repos/fictional/demo/issues/1/comments?per_page=100&page=1': [], 'POST repos/fictional/demo/issues/1/comments': { id: 10, html_url: 'https://example.invalid/pull/1#issuecomment-10' },
  });
  const intent = intentFor(workspace.path, f, { operation: 'forge.publish', config: { ...deliveryConfig(f.gh, repositoryExtra), mode: undefined, version: undefined }, workspace, candidate: { number: 1, head: ADOPTED, base: BASE }, results: { integrate: { base: targetHead, head: repositoryIdentity(workspace.path).head, conflicts: false, route: 'integrated' }, candidate: { originalPR: { number: 1, url: 'https://example.invalid/pull/1', head: ADOPTED, base: BASE, author: 'outside-dev' } } } });
  return { f, intent };
}
test('publishing the replacement links the original PR and its author, and comments once on the original', async t => {
  const { f, intent } = await publishFixture(t);
  const result = await runAction(intent);
  assert.equal(result.route, 'published'); assert.equal(result.originalPRNotice.status, 'published');
  assert.deepEqual(result.obligations?.map(row => [row.id, row.status, row.evidence]), [['flow-1:original-pr', 'pending', 'https://example.invalid/pull/1']], 'the superseded-PR to-do is created once the replacement is published');
  const calls = await f.calls(), pr = JSON.parse(calls.find(call => call.method === 'POST' && call.endpoint === 'repos/fictional/demo/pulls').input);
  assert.match(pr.body, /Adopted from pull request #1 by outside\\-dev \(https:\/\/example\.invalid\/pull\/1\): its approved head aaaaaaaaaaaa is delivered here unchanged/);
  assert.doesNotMatch(pr.body, /@outside/, 'the replacement never mentions the author');
  const comment = JSON.parse(calls.find(call => call.method === 'POST' && call.endpoint === 'repos/fictional/demo/issues/1/comments').input).body;
  assert.match(comment, /^This pull request was adopted for delivery\. Its commits up to aaaaaaaaaaaa are carried unchanged in a replacement pull request: https:\/\/example\.invalid\/pull\/7\./);
  assert.match(comment, /Commits pushed here after adoption are not included automatically/);
  assert.doesNotMatch(comment, /@|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#/i);
  assert.match(comment, /<!-- factotum:[a-f\d]{64} -->/, 'marked, so a retry does not post twice');
});
test('repository.adoptionNotice: false publishes no comment on the original PR', async t => {
  const { f, intent } = await publishFixture(t, { adoptionNotice: false });
  const result = await runAction(intent);
  assert.equal(result.route, 'published'); assert.equal(result.originalPRNotice, undefined);
  assert.equal((await f.calls()).some(call => call.endpoint === 'repos/fictional/demo/issues/1/comments'), false);
});
test('a failed comment on the original PR is recorded and does not fail the publication', async t => {
  const { f, intent } = await publishFixture(t);
  const responses = JSON.parse(await readFile(join(f.directory, 'bin', 'responses.json'), 'utf8')); delete responses['POST repos/fictional/demo/issues/1/comments']; await f.respond(responses);
  const result = await runAction(intent);
  assert.equal(result.route, 'published'); assert.equal(result.originalPRNotice.status, 'failed');
});

// ---- 4. Only the operator answers an adopted PR's merge question ----

test('the orchestrator cannot answer an adopted merge question, whatever the delegation settings', async t => {
  const instruction = { principal: 'operator', instruction: 'Operator in thread: "merge it"' };
  const f = await decideFixture(t, { policy: { delegatedOperations: ['answer'], mergeDecisionRole: 'orchestrator' } });
  assert.equal(f.item.role, 'operator');
  for (const attempt of [f.answer('orchestrator'), f.answer('orchestrator', {}, instruction), f.answer('orchestrator', { answer: 'stop' }, instruction)]) {
    assert.equal(attempt.status, 'rejected'); assert.equal(attempt.error, ADOPTED_MERGE_OPERATOR_ONLY);
  }
  const item = f.store.need('inbox', f.item.id);
  assert.equal(item.status, 'open'); assert.equal(item.version, f.item.version, 'a refusal consumes nothing');
  assert.equal(f.store.need('flow', 'flow-1').mergeAuthorization ?? null, null);
  assert.equal(f.answer('operator').status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').mergeAuthorization.actor, 'operator');
  // An orchestrator authorization recorded before this rule (an in-flight flow) is refused before merge.
  const flow = f.store.need('flow', 'flow-1');
  assert.throws(() => actions.verifyDecision(f.store, { ...flow, mergeAuthorization: { ...flow.mergeAuthorization, actor: 'orchestrator', authority: 'delegated' } }), /operator's own decision/);
});
test('strict adopted candidates go to the operator even with strictDecisionRole orchestrator', async t => {
  const f = await decideFixture(t, { risk: 'strict', strictDecisionRole: 'orchestrator' });
  assert.equal(f.item.role, 'operator');
  assert.equal(f.answer('orchestrator', { reviewedHead: f.identity.head }).error, ADOPTED_MERGE_OPERATOR_ONLY);
});
test('a non-adopted merge question keeps its delegation', async t => {
  const f = await decideFixture(t, { candidate: null, policy: { delegatedOperations: ['answer'] } });
  assert.equal(f.answer('orchestrator', {}, { principal: 'operator', instruction: 'merge it' }).status, 'completed');
});

// ---- 5. Admission and source verification wait for a merge in flight ----

function twoFlows(t, policy = {}) {
  const f = sandbox(t);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { mainProbeMs: 0, maxFlows: 3, autoQueue: true, ...policy } };
  assert.equal(f.command('config.update', { config, note: 'Commission fictional delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  assert.equal(f.command('task.approve', { taskId: 'task-1', revision: f.store.need('task', 'task-1').revision }).status, 'completed');
  const waiting = f.store.tx(() => admitFlow(f.store, f.store.need('task', 'task-1'), { revision: f.store.need('task', 'task-1').revision }));
  // Another flow, as an earlier admission left it: answered merge and now at its merge step.
  f.command('task.put', { task: { id: 'task-2', title: 'Fictional second feature', acceptance: ['Observed'] } });
  const merging = { ...f.store.need('flow', waiting.id), id: 'flow-merging', taskId: 'task-2', step: 'merge', state: 'ready', attemptId: null };
  f.store.put('flow', merging);
  f.command('task.put', { task: { id: 'task-3', title: 'Fictional third feature', acceptance: ['Observed'] } });
  f.command('task.approve', { taskId: 'task-3', revision: f.store.need('task', 'task-3').revision });
  return { ...f, waitingId: waiting.id };
}
test('admission is held while a merge into the target is in flight, and the queue says why', t => {
  const f = twoFlows(t);
  const reasons = admissionReasons(f.store, f.store.need('task', 'task-3'));
  assert.ok(reasons.includes('main merge in progress (flow flow-merging); new work waits for it and its post-merge verification'), reasons.join('; '));
  const hold = queueStatus(f.store).holds.find(row => row.kind === 'merge');
  assert.deepEqual(hold.flowIds, ['flow-merging']);
  // The dashboard reads through a projecting view (no workflow on its flow records): the hold still shows.
  assert.ok(dashboardSnapshot(f.store).queueStatus.holds.some(row => row.kind === 'merge'), 'dashboard queue status shows the merge hold');
  f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  assert.ok(!admissionReasons(f.store, f.store.need('task', 'task-3')).some(reason => /merge in progress/.test(reason)));
  assert.equal(queueStatus(f.store).holds.some(row => row.kind === 'merge'), false);
});
test('a flow at source waits (not stopped) for a merge in flight and its verification, then continues by itself', async t => {
  const f = twoFlows(t);
  await f.engine.step(f.waitingId);
  let flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.attemptId, null); assert.equal(flow.targetWait.kind, 'merge'); assert.equal(flow.stopReason ?? null, null);
  // Stepping again while still waiting writes nothing new.
  const events = f.store.events(200).filter(e => e.type === 'flow.target-wait').length;
  await f.engine.step(f.waitingId); assert.equal(f.store.events(200).filter(e => e.type === 'flow.target-wait').length, events);
  // The merge settles: main moved, its post-merge verification is queued.
  f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  f.store.tx(() => { setTargetHealth(f.store, 'main', { status: 'unknown', head: H('e'), checkedAt: new Date().toISOString(), reason: 'Post-merge baseline verification required' }); f.store.put('job', { id: 'post-merge-main:flow-merging', operation: 'main.verify', payload: {}, status: 'queued', createdAt: new Date().toISOString() }); });
  await f.engine.step(f.waitingId);
  flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.targetWait.kind, 'verification'); assert.match(flow.targetWait.reason, /post-merge-main:flow-merging/);
  // Verified green: the flow prepares its source verification without a resume.
  f.store.tx(() => { setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() }); f.store.put('job', { ...f.store.need('job', 'post-merge-main:flow-merging'), status: 'completed' }); });
  await f.engine.step(f.waitingId);
  flow = f.store.need('flow', f.waitingId);
  assert.ok(flow.attemptId, 'source verification prepared'); assert.equal(flow.targetWait, undefined); assert.equal(flow.state, 'running');
  assert.ok(f.store.events(200).some(e => e.type === 'flow.target-released'));
});
test('a source verification that observed a moved target waits while the verification is on its way', async t => {
  const f = twoFlows(t);
  f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  await f.engine.step(f.waitingId);
  const attempt = f.store.need('attempt', f.store.need('flow', f.waitingId).attemptId);
  // A running verification, as a structural stub: a maintenance flow record that is never executed
  // here (its copied graph has no `run` step). Only its state is read, which is what the wait judges;
  // the real verifier lifecycle (operations tick, stop, resume, abandon) is covered further down.
  f.store.tx(() => { f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), id: 'verifier-flow', kind: 'maintenance', step: 'run', state: 'running', finishedAt: null }); f.store.put('job', { id: 'post-merge-main:flow-merging', operation: 'main.verify', payload: {}, status: 'running', flowId: 'verifier-flow', createdAt: new Date().toISOString() }); });
  f.engine.settle(f.waitingId, attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'target-unverified', targetHealthHold: { target: 'main', head: H('e') }, reason: 'main needs current verification' } });
  const flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.step, 'source'); assert.equal(flow.targetWait.kind, 'verification'); assert.equal(flow.stopReason ?? null, null);
  // Without a verification on its way, and none the factory may ask for (policy.autoQueue off), the
  // earlier stop stands. With autoQueue the flow asks for one and waits: tests/admission-capacity.test.mjs.
  const g = twoFlows(t, { autoQueue: false });
  g.store.put('flow', { ...g.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  await g.engine.step(g.waitingId);
  const other = g.store.need('attempt', g.store.need('flow', g.waitingId).attemptId);
  g.engine.settle(g.waitingId, other, { exitCode: 0, costMicros: 0, actionResult: { route: 'target-unverified', targetHealthHold: { target: 'main', head: H('e') }, reason: 'main needs current verification' } });
  assert.equal(g.store.need('flow', g.waitingId).state, 'stopped');
});
test('a prepared source verification is not dispatched when a merge starts meanwhile; the flow waits', async t => {
  const f = twoFlows(t);
  const merging = f.store.need('flow', 'flow-merging'); f.store.put('flow', { ...merging, step: 'done', state: 'completed' });
  await f.engine.step(f.waitingId);
  const attemptId = f.store.need('flow', f.waitingId).attemptId; assert.ok(attemptId);
  f.store.put('flow', merging);
  await f.engine.step(f.waitingId);
  assert.equal(f.store.need('attempt', attemptId).status, 'not-dispatched');
  const flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.attemptId, null); assert.equal(flow.targetWait.kind, 'merge');
});

// ---- Review fixes: a wait is judged from the verifier's (or merger's) actual state ----

// The source flow of twoFlows with no merge in flight, main unverified, and a main.verify job
// admitted by the real operations tick (its maintenance flow exists, not yet executed).
async function admittedVerifier(t) {
  const f = twoFlows(t);
  f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  setTargetHealth(f.store, 'main', { status: 'unknown', head: H('e'), checkedAt: new Date().toISOString(), reason: 'Post-merge baseline verification required' });
  const enqueued = f.command('job.enqueue', { operation: 'main.verify', note: 'Verify main after the fictional merge' });
  assert.equal(enqueued.status, 'completed', enqueued.error);
  await operationalTick(f.store);
  const job = f.store.need('job', enqueued.result.id), verifierId = job.flowId;
  assert.equal(job.status, 'running'); assert.ok(verifierId, 'the operations loop admitted the verifier');
  await f.engine.step(f.waitingId);
  assert.equal(f.store.need('flow', f.waitingId).targetWait.kind, 'verification', 'waits while the verifier can run');
  return { ...f, jobId: job.id, verifierId };
}
const resumeCommand = (f, flowId) => f.command('resume', { flowId, note: 'Recover the fictional flow' });

test('a stopped verifier stops the waiting source flow with a reason naming it and the recovery', async t => {
  const f = await admittedVerifier(t);
  assert.equal(f.command('stop', { flowId: f.verifierId, note: 'Operator stops the fictional verifier' }).status, 'completed');
  assert.equal(f.store.need('job', f.jobId).status, 'running', 'the job record alone still says running');
  await f.engine.step(f.waitingId);
  const flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'stopped'); assert.equal(flow.step, 'source'); assert.equal(flow.resumeStep, 'source'); assert.equal(flow.targetWait, undefined);
  assert.ok(flow.stopReason.includes(`main.verify job ${f.jobId} cannot proceed: its verifier flow ${f.verifierId} is stopped`), flow.stopReason);
  assert.match(flow.stopReason, /resume flow .* \(resume\) or abandon it \(flow\.abandon\) and run main\.verify again \(or doctor\)/);
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === f.waitingId && row.status === 'open');
  assert.ok(notice?.context.includes(f.verifierId), 'the operator is told');
  assert.ok(f.store.events(100).some(e => e.type === 'flow.target-wait-blocked' && e.payload.verifierFlowId === f.verifierId));
});

test('after the verifier is resumed, the resumed source flow waits for it and continues once main is green', async t => {
  const f = await admittedVerifier(t);
  f.command('stop', { flowId: f.verifierId, note: 'Operator stops the fictional verifier' });
  await f.engine.step(f.waitingId); assert.equal(f.store.need('flow', f.waitingId).state, 'stopped');
  assert.equal(resumeCommand(f, f.verifierId).status, 'completed');
  assert.equal(resumeCommand(f, f.waitingId).status, 'completed');
  await f.engine.step(f.waitingId);
  let flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.targetWait.kind, 'verification');
  // The verifier's result, as its settlement records it.
  f.store.tx(() => { setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() }); f.store.put('flow', { ...f.store.need('flow', f.verifierId), state: 'completed', finishedAt: new Date().toISOString() }); f.store.put('job', { ...f.store.need('job', f.jobId), status: 'completed' }); });
  await f.engine.step(f.waitingId);
  flow = f.store.need('flow', f.waitingId);
  assert.ok(flow.attemptId, 'source verification prepared'); assert.equal(flow.state, 'running'); assert.equal(flow.targetWait, undefined);
});

test('after the verifier is abandoned, a new verification frees the source flow to wait for it again', async t => {
  const f = await admittedVerifier(t);
  f.command('stop', { flowId: f.verifierId, note: 'Operator stops the fictional verifier' });
  await f.engine.step(f.waitingId); assert.equal(f.store.need('flow', f.waitingId).state, 'stopped');
  assert.equal(f.command('flow.abandon', { flowId: f.verifierId, note: 'Abandon the fictional verifier' }).status, 'completed');
  assert.equal(f.store.need('job', f.jobId).status, 'abandoned');
  assert.equal(sourceWait(f.store, 'main'), null, 'nothing is promised any more: no verification on its way');
  const again = f.command('job.enqueue', { operation: 'main.verify', note: 'Verify main again' }).result;
  await operationalTick(f.store);
  assert.equal(f.store.need('job', again.id).status, 'running', 'the maintenance slot is free again');
  assert.equal(resumeCommand(f, f.waitingId).status, 'completed');
  await f.engine.step(f.waitingId);
  const flow = f.store.need('flow', f.waitingId);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.targetWait.jobId, again.id);
});

test('a queued verification behind a stopped maintenance flow, and stopped or held merges, promise nothing', async t => {
  const f = twoFlows(t);
  // A stopped merge or one held by a decision does not hold admission or source flows.
  const merging = f.store.need('flow', 'flow-merging');
  assert.equal(mergesInFlight(f.store, 'main').length, 1);
  f.store.put('flow', { ...merging, state: 'stopped', stopRequested: true });
  assert.equal(mergesInFlight(f.store, 'main').length, 0);
  f.store.put('flow', { ...merging, state: 'waiting', decisionHold: { step: 'merge', boundary: 'merge', decisions: [], reasons: [] } });
  assert.equal(mergesInFlight(f.store, 'main').length, 0);
  f.store.put('flow', { ...merging, step: 'done', state: 'completed' });
  // A queued main.verify cannot start while a stopped maintenance flow holds the slot.
  setTargetHealth(f.store, 'main', { status: 'unknown', head: H('e'), checkedAt: new Date().toISOString() });
  f.store.put('job', { id: 'verify-queued', operation: 'main.verify', payload: {}, status: 'queued', createdAt: new Date().toISOString() });
  assert.equal(sourceWait(f.store, 'main').blocked, undefined);
  f.store.put('flow', { ...f.store.need('flow', f.waitingId), id: 'maintenance-stopped', kind: 'maintenance', taskId: 'task-2', state: 'stopped', stopRequested: true });
  const wait = sourceWait(f.store, 'main');
  assert.equal(wait.blocked, true); assert.match(wait.reason, /maintenance flow maintenance-stopped, which is stopped, holds the maintenance slot/);
});

// ---- Review fixes, round 2 ----

test('a rolled-back transaction leaves no cached merge state behind', t => {
  const f = twoFlows(t);
  const merging = f.store.need('flow', 'flow-merging');
  f.store.put('flow', { ...merging, step: 'done', state: 'completed' });
  assert.equal(mergesInFlight(f.store, 'main').length, 0);
  let inside;
  assert.throws(() => f.store.tx(() => {
    f.store.put('flow', merging);
    assert.equal(mergesInFlight(f.store, 'main').length, 1, 'seen inside the transaction (and cached there)');
    inside = f.store.changeToken();
    throw new Error('fictional failure after the read');
  }), /fictional failure/);
  assert.equal(f.store.need('flow', 'flow-merging').state, 'completed', 'the write was rolled back');
  assert.notEqual(f.store.changeToken(), inside, 'a rollback changes the change token');
  assert.equal(mergesInFlight(f.store, 'main').length, 0, 'the rolled-back state is not served from the cache');
  assert.equal(admissionReasons(f.store, f.store.need('task', 'task-3')).some(reason => /merge in progress/.test(reason)), false);
});

test('a decision-held or uncertain maintenance flow in the slot leaves a queued verification blocked', t => {
  const f = twoFlows(t);
  f.store.put('flow', { ...f.store.need('flow', 'flow-merging'), step: 'done', state: 'completed' });
  setTargetHealth(f.store, 'main', { status: 'unknown', head: H('e'), checkedAt: new Date().toISOString() });
  f.store.put('job', { id: 'verify-queued', operation: 'main.verify', payload: {}, status: 'queued', createdAt: new Date().toISOString() });
  const occupant = { ...f.store.need('flow', f.waitingId), id: 'maintenance-occupant', kind: 'maintenance', taskId: 'task-2', step: 'run', attemptId: null };
  // A progressing occupant (running, no attempt yet) will free the slot: the source flow waits.
  f.store.put('flow', { ...occupant, state: 'running' });
  assert.equal(sourceWait(f.store, 'main').blocked, undefined);
  f.store.put('flow', { ...occupant, state: 'waiting', decisionHold: { step: 'run', boundary: 'release', decisions: [], reasons: ['held'] } });
  let wait = sourceWait(f.store, 'main');
  assert.equal(wait.blocked, true); assert.match(wait.reason, /maintenance flow maintenance-occupant, which is held by a decision, holds the maintenance slot/);
  f.store.put('attempt', { id: 'occupant-attempt', flowId: 'maintenance-occupant', step: 'run', status: 'uncertain', createdAt: new Date().toISOString() });
  f.store.put('flow', { ...occupant, state: 'running', attemptId: 'occupant-attempt' });
  wait = sourceWait(f.store, 'main');
  assert.equal(wait.blocked, true); assert.match(wait.reason, /which has an uncertain attempt, holds the maintenance slot/);
  // An integration workflow's maintenance flow does not take the plain maintenance slot.
  f.store.put('flow', { ...occupant, state: 'stopped', stopRequested: true, attemptId: null, integration: { id: 'fictional-release' } });
  assert.equal(sourceWait(f.store, 'main').blocked, undefined);
});
