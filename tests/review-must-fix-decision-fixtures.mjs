// Fixtures for must-fix review slice 5 (docs/designs/review-must-fix.md 7.4, 12.5, 13.4): a delivery
// flow driven through the engine, step by step, with the real dispatcher for every effect, scripted
// providers for the builder and the reviewer, the real `answer` command, and a scripted `gh` as the
// forge. A flow pinned to `must-fix` exists only in fixtures: configuration validation still refuses
// the setting, so the flow is pinned to it directly after it starts.
//
// The graph is the reference change graph's own nodes from review to merge (and, for an
// already-satisfied flow, its satisfied review, gate, question and record), entered at the build step.
// The integration and publication the reference graph runs before review are recorded as results the
// flow already has (the base the candidate was integrated with, and pull request 7): they are not
// what this slice changes, and they need an owned workspace. The gate runs through the dispatcher
// without the host's heavy-work lease (a contained supervisor's identity), which is all that differs.
//
// The engine also launches its supervisor for each step it dispatches. Those processes find only
// stand-in provider commands on PATH (tests/run.mjs), so no provider session can start; each step is
// settled from the in-process run first.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { purposeOf } from './review-bar-scenarios.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { computeReviewLedger } from '../starter/factory/workflows/review-ledger.mjs';

const stand = mkdtempSync(join(tmpdir(), 'fct-mf5-bin-'));
for (const name of ['claude', 'codex']) { writeFileSync(join(stand, name), '#!/bin/sh\necho "fictional provider: not available in tests" >&2\nexit 1\n'); chmodSync(join(stand, name), 0o755); }
process.env.PATH = `${stand}${delimiter}${process.env.PATH}`;
process.on('exit', () => rmSync(stand, { recursive: true, force: true }));

export const ACCEPTANCE = ['Each record is read once', 'The reader reports a missing file'];
export const FACTS = [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }];
const ordinaryAssessment = { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] };
const strictAssessment = { level: 'strict', rationale: 'Fictional saved records', threatModel: ['Loss of fictional records'], stopConditions: ['Halt when integrity is unproven'] };
export const cite = (kind, extra = {}) => ({ kind, ref: '-', quote: '', head: null, check: null, result: null, covers: 'The step where the wrong result appears', ...extra });
export const fileCite = (quote = 'records are read once') => cite('file', { ref: 'input.txt', quote });
export const finding = (message, purposeImpact, status, evidence = [], extra = {}) => ({ severity: 'high', file: 'input.txt', line: 1, message, scenario: `${message}: concrete inputs, path and wrong result.`, reachable: { status, evidence, coverage: evidence.length ? 'The cited reader path is the only one, and the evidence covers each step.' : '' }, purposeImpact, silent: false, origin: 'new-code', fixOf: null, ...extra });
export const judge = (id, judgement, extra = {}) => ({ id, judgement, sameScenario: false, coverage: '', relevance: [], evidence: [], ...extra });
export const purpose = (extra = {}) => purposeOf(ACCEPTANCE, extra);
export const changeResult = ({ verdict = 'pass', findings = [], ledger = [], strict = false, purpose: assessed = purpose() } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinaryAssessment, strictReview: { fullDiffInspected: true, threatModelReviewed: strict, stopConditionsReviewed: strict }, scopeSummary: 'All', learningsChecked: [], purpose: assessed, ledger });
// A severity review (today's schema): no purpose, no ledger, priorFindingsDisposition.
export const severityResult = ({ verdict = 'pass', findings = [], strict = false } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinaryAssessment, strictReview: { fullDiffInspected: true, threatModelReviewed: strict, stopConditionsReviewed: strict }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [] });
export const defer = (id, evidence, extra = {}) => ({ id, disposition: 'deferred', reason: 'cant-happen-here', evidence, coverage: 'The cited guard is on the only path the scenario takes.', note: '', ...extra });
const buildResult = (status, findingDispositions) => ({ status, summary: `Fictional ${status} build`, departures: [], unverified: [], pushback: [], questions: [], assumptions: [], learningsApplied: [], ...(findingDispositions ? { findingDispositions } : {}) });
const receipt = actionResult => ({ exitCode: 0, reason: null, costMicros: 0, actionResult });
let session = 0;
export const scripted = (results, calls = [], { family = 'anthropic', provider = 'claude' } = {}) => async spec => { calls.push(spec); const result = results.shift(); assert.ok(result, `no scripted answer for call ${calls.length}`); return { provider, model: 'fictional', family, sessionId: `session-${++session}`, result: structuredClone(result) }; };
export const instruction = { principal: 'operator', instruction: 'Merge the fictional change as discussed.' };
export const acks = items => items.map(item => ({ id: item.id, claimDigest: item.claimDigest }));

// A fictional gh: answers what follow-ups, the gate's status and the merge ask (with branch protection
// that enforces the gate's status, as automatic merge needs); records every call;
// serves pull request 7 from pr.json, which the fixture writes once it knows the candidate.
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
if(method==='POST'&&endpoint==='repos/fictional/demo/issues')value={number:11,id:1011,html_url:'https://example.invalid/issues/11',body:input.body};
else if(method==='POST'&&/issues\\/\\d+\\/comments$/.test(endpoint))value={id:Date.now(),body:input.body};
else if(method==='POST'&&/\\/statuses\\//.test(endpoint))value={id:1,state:input.state};
else if(method==='PUT'&&endpoint==='repos/fictional/demo/pulls/7/merge')value={merged:true,sha:'f'.repeat(40)};
else if(method==='GET'&&endpoint==='repos/fictional/demo/pulls/7'&&pr)value={number:7,state:'open',draft:false,merged:false,commits:1,head:{sha:pr.head,ref:pr.branch},base:{sha:pr.base,ref:'main'},html_url:'https://example.invalid/pull/7',title:pr.title,body:''};
else if(method==='GET'&&endpoint.startsWith('repos/fictional/demo/pulls/7/commits')&&pr)value=[{sha:pr.head,commit:{message:'Fictional reader change'}}];
else if(method==='GET'&&endpoint==='repos/fictional/demo/branches/main/protection')value={required_status_checks:{strict:true,contexts:['factotum/gate']},enforce_admins:{enabled:true}};
else if(method==='GET'&&endpoint.includes('per_page='))value=[];
if(value===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
console.log(JSON.stringify(value));
`); chmodSync(gh, 0o700);
  return gh;
}

// The reference graph's nodes, entered at the build step (or, satisfied, at the satisfied review).
function graph(config, { satisfied = false } = {}) {
  const n = changeWorkflow(config, { preview: false, fastChecks: false }).nodes, ref = changeWorkflow(config, { preview: false, fastChecks: false });
  if (satisfied) return { version: 1, maxTransitions: ref.maxTransitions, start: 'satisfied-review', nodes: { 'satisfied-review': n['satisfied-review'], 'satisfied-gate': n['satisfied-gate'], 'satisfied-decide': n['satisfied-decide'], 'satisfied-record': { ...n['satisfied-record'], next: 'done' }, done: n.done, failed: n.failed, stopped: n.stopped } };
  return { version: 1, maxTransitions: ref.maxTransitions, start: 'build', nodes: {
    build: { ...n.build, next: 'review', resultEdges: { implemented: 'review', blocked: 'build-question' } }, 'build-question': n['build-question'],
    review: n.review, 'delta-review': n['delta-review'], followups: n.followups, 'review-question': n['review-question'],
    gate: n.gate, 'gate-question': n['gate-question'], decide: n.decide,
    merge: { ...n.merge, next: 'done', resultEdges: { merged: 'done', stale: 'failed' } },
    done: n.done, failed: n.failed, stopped: n.stopped } };
}

// A delivery flow. `bar`: must-fix (pinned after start) or severity; `review`: policy.review settings;
// `policy`: other policy (mergeDecisionRole, strictDecisionRole, autoMerge); `satisfied`: an
// already-satisfied flow (its target is the candidate).
export async function decisionFlow(t, { risk = 'ordinary', protocol = 'fresh-full', bar = 'must-fix', review = {}, policy = {}, satisfied = false, qualified = false } = {}) {
  const f = sandbox(t);
  const bin = mkdtempSync(join(tmpdir(), 'fct-mf5-gh-')), remote = join(bin, 'remote.git'); t.after(() => rmSync(bin, { recursive: true, force: true }));
  const gh = fakeGh(bin);
  const git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]);
  const base = git(['rev-parse', 'HEAD']); git(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: gh }, providers: { builder: { provider: 'claude', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], policy: { planning: false, reviewProtocol: protocol, ...policy, ...(bar === 'severity' ? {} : { reviewBar: 'shadow', review: { environment: FACTS, ...review } }) }, context: { files: [], maxChars: 1000 }, ...(qualified ? { qualification: { qualified: true, targetFreshness: 'strict-status' } } : {}) };
  const workflow = graph(config, { satisfied });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional reader', outcome: 'Fictional records are read once', acceptance: ACCEPTANCE, risk } });
  f.start();
  const flow = f.store.need('flow', 'flow-1');
  Object.assign(flow, { mode: 'delivery', kind: 'change', configDigest: digest(config) });
  flow.results.source = { head: base, route: satisfied ? 'satisfied' : 'ready' };
  if (satisfied) flow.completionMode = 'already-satisfied';
  else { flow.results.integrate = { base, head: base, conflicts: false, route: 'integrated' }; flow.results.publish = { number: 7, url: 'https://example.invalid/pull/7', branch: 'fictional-reader', route: 'published' }; }
  if (bar === 'must-fix') flow.reviewBar = 'must-fix';
  f.store.put('flow', flow);
  let edits = 0;
  const current = () => f.store.need('flow', 'flow-1');
  const prepare = async () => { await f.engine.tick(); const now = current(); assert.ok(now.attemptId, `no attempt at ${now.step} (${now.state}): ${now.stopReason ?? ''}`); return f.store.need('attempt', now.attemptId); };
  // One step: the engine prepares it, the dispatcher runs it in this process, the engine settles it.
  const run = async (invoke, change = action => action) => {
    const attempt = await prepare(), out = await runAction({ ...attempt.intent, action: change(attempt.intent.action) }, { providerInvoke: invoke });
    f.engine.settle('flow-1', attempt, receipt(out)); return out;
  };
  const build = (dispositions = [], { edit = true } = {}) => run(async () => {
    if (edit) { writeFileSync(join(f.root, 'input.txt'), `records are read once\ncandidate ${++edits}\n`); execFileSync('git', ['commit', '-qam', `Fictional candidate ${edits}`], { cwd: f.root }); }
    return { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: `builder-${++session}`, result: buildResult('implemented', bar === 'must-fix' ? dispositions : undefined) };
  });
  const reviewWith = (results, calls = [], who = {}) => run(scripted(structuredClone(results), calls, who));
  const effect = () => run(async () => { throw new Error('no provider in this step'); });
  // The gate, through the dispatcher, without the host's heavy-work lease.
  const gate = () => run(async () => { throw new Error('no provider in the gate'); }, action => ({ ...action, resource: false }));
  const open = () => f.store.all('inbox').find(item => item.flowId === 'flow-1' && item.kind === 'question' && item.status === 'open');
  // The engine opens a question on the tick that reaches it (a step that moves the flow back to it needs a second).
  const question = async () => { for (let n = 0; n < 3 && (!open() || n === 0); n++) await f.engine.tick(); return open(); };
  // An end step is reached on the next tick.
  const finish = async () => { await f.engine.tick(); return current(); };
  const send = (operation, payload, { actor = 'operator', onBehalfOf } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
  const answer = async (choice, extra = {}, who = {}) => { const item = await question(); assert.ok(item, `no open question at ${current().step}`); return send('answer', { inboxId: item.id, answer: choice, version: item.version, subjectDigest: item.subjectDigest, ...extra }, who); };
  const publishPR = () => writeFileSync(join(bin, 'pr.json'), JSON.stringify({ head: repositoryIdentity(f.root).head, base, branch: 'fictional-reader', title: 'Fictional reader' }));
  const calls = () => existsSync(join(bin, 'calls.jsonl')) ? readFileSync(join(bin, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const merges = () => calls().filter(call => call.method === 'PUT');
  const ledger = () => computeReviewLedger(current());
  // For an already-satisfied flow the target is the candidate itself.
  const targetIsHead = () => git(['push', '-q', '-f', 'origin', 'HEAD:refs/heads/main']);
  return { ...f, config, base, gh, bin, current, finish, run, build, review: reviewWith, effect, gate, question, answer, send, publishPR, calls, merges, ledger, targetIsHead, mkdir: dir => mkdirSync(dir, { recursive: true }) };
}
