// Review scenarios for the review bar's severity identity (docs/designs/review-must-fix.md 5.5, 15):
// plan review, change review under both protocols and both risk levels, the satisfied review and
// the builder brief that follows a review, each run through the real dispatcher with scripted
// reviewers on a repository whose commits are deterministic. The capture holds every prompt,
// every schema handed to a provider, every result the dispatcher returned, the review history the
// engine's own recorders write, and the strict requirement's digest. A golden capture taken before
// the review bar existed is in tests/fixtures/review-severity-golden.json.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { recordReview } from '../starter/factory/core/delivery-review.mjs';
import { recordRiskAssessment, riskSummary, strictReviewRequirement } from '../starter/factory/core/risk.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const GIT_ENV = { GIT_AUTHOR_NAME: 'Fictional Evaluator', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fictional Evaluator', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (root, args) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const commit = (root, file, text, message) => { writeFileSync(join(root, file), text); git(root, ['add', '.']); git(root, ['commit', '-qm', message]); };

const strictAssessment = { level: 'strict', rationale: 'Protect fictional saved records', threatModel: ['Loss of fictional records'], stopConditions: ['Halt when record integrity is unproven'] };
const ordinaryAssessment = { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] };
const attest = { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true };
const finding = (severity, message, extra = {}) => ({ severity, file: 'records.txt', line: 1, message, ...extra });
// A change review result in today's shape. `extra` may carry must-fix fields for a shadow run.
export const changeReview = (verdict, findings, { strict = false, prior = [] } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinaryAssessment, strictReview: strict ? attest : { fullDiffInspected: true, threatModelReviewed: false, stopConditionsReviewed: false }, scopeSummary: 'The entire fictional change', priorFindingsDisposition: prior, learningsChecked: [] });
const planReview = (verdict, findings, assessment = ordinaryAssessment) => ({ verdict, summary: `Fictional plan ${verdict}`, findings, riskAssessment: assessment });

// The scenarios. Each step names its operation, the scripted results it returns in order and,
// for a change review, an edit committed before it so every round reviews a new candidate.
export const SCENARIOS = [
  { name: 'fresh-full-ordinary', protocol: 'fresh-full', risk: 'ordinary', steps: [
    { op: 'review', results: [changeReview('revise', [finding('high', 'Records are written twice')])] },
    { op: 'build' },
    { op: 'review', edit: 'second', results: [changeReview('pass', [finding('low', 'Name the record format')])] },
    { op: 'review', edit: 'third', results: [changeReview('pass', [finding('medium', 'Document the reader')])] },
    { op: 'review', edit: 'fourth', results: [changeReview('pass', [])] },
  ] },
  { name: 'fresh-full-strict', protocol: 'fresh-full', risk: 'strict', steps: [
    { op: 'review', results: [changeReview('pass', [finding('low', 'Clarify the record format')], { strict: true })] },
    { op: 'build' },
    { op: 'review', edit: 'second', results: [changeReview('pass', [], { strict: true })] },
  ] },
  { name: 'bounded-strict', protocol: 'bounded-delta', risk: 'strict', steps: [
    { op: 'review', results: [changeReview('pass', [], { strict: true })] },
    { op: 'review', edit: 'second', results: [changeReview('revise', [finding('high', 'Integrity check skipped')], { strict: true })] },
    { op: 'build' },
    { op: 'review', edit: 'third', results: [changeReview('pass', [finding('low', 'Rename the reader')], { strict: true, prior: [{ finding: 'Integrity check skipped', disposition: 'fixed', evidence: 'records.txt line 1' }] })] },
    { op: 'review', edit: 'fourth', results: [changeReview('pass', [], { strict: true })] },
  ] },
  { name: 'bounded-ordinary', protocol: 'bounded-delta', risk: 'ordinary', policy: { ordinaryReviewRounds: 3, ordinaryFollowupAfter: 2 }, steps: [
    { op: 'review', results: [changeReview('revise', [finding('high', 'Reader drops the last record')])] },
    { op: 'review', edit: 'second', results: [changeReview('revise', [finding('medium', 'Reader is slow')])] },
    { op: 'review', edit: 'third', results: [changeReview('revise', [finding('high', 'Reader still drops records')])] },
    { op: 'review', edit: 'fourth', results: [changeReview('revise', [finding('high', 'Reader drops records again')], { prior: [{ finding: 'Reader still drops records', disposition: 'remaining', evidence: 'records.txt line 1' }] })] },
  ] },
  { name: 'escalation', protocol: 'bounded-delta', risk: 'ordinary', steps: [
    { op: 'review', results: [changeReview('pass', [], { strict: true })] },
  ] },
  { name: 'satisfied', protocol: 'bounded-delta', risk: 'strict', satisfied: true, steps: [
    { op: 'review', results: [changeReview('pass', [finding('low', 'Already satisfied but untidy')], { strict: true })] },
    { op: 'review', results: [changeReview('pass', [], { strict: true })] },
  ] },
  { name: 'plan-review', protocol: 'fresh-full', risk: 'ordinary', steps: [
    { op: 'plan', results: [planReview('pass', [])] },
    { op: 'plan', results: [planReview('pass', [finding('low', 'Optional observation')]), planReview('pass', [])] },
    { op: 'plan', results: [planReview('pass', [finding('low', 'Optional observation')]), planReview('pass', [finding('low', 'Optional observation')])] },
    { op: 'plan', results: [planReview('revise', [finding('high', 'Plan misses the reader')])] },
    { op: 'plan', results: [planReview('pass', [], { ...strictAssessment, stopConditions: [] })] },
  ] },
];

// Run every scenario. `policy` is merged into each scenario's policy; `action(scenario)` returns
// fields added to every action input (what workflows/actions.mjs adds for a flow); `results`
// may replace a step's scripted results.
export async function captureReviewScenarios({ policy = {}, action = () => ({}), results = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fct-bar-'));
  try {
    const out = {};
    for (const scenario of SCENARIOS) out[scenario.name] = await runScenario(join(base, scenario.name), scenario, { policy, action, results });
    return JSON.parse(JSON.stringify(out).replaceAll(base, '<base>'));
  } finally { rmSync(base, { recursive: true, force: true }); }
}

async function runScenario(dir, scenario, options) {
  const root = join(dir, 'repo'); mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  commit(root, 'records.txt', 'fictional baseline\n', 'Fictional baseline');
  const baseHead = repositoryIdentity(root).head;
  if (!scenario.satisfied) commit(root, 'records.txt', 'fictional baseline\nfirst candidate\n', 'First candidate');
  const config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'fictional-planner' }, builder: { provider: 'codex', model: 'fictional-builder' }, reviewer: { provider: 'claude', model: 'fictional-reviewer' } }, policy: { reviewProtocol: scenario.protocol, ...scenario.policy, ...options.policy }, context: { files: [], maxChars: 1000 } };
  const task = { id: 'task-1', title: 'Fictional record reader', outcome: 'Fictional records are read once', acceptance: ['Each record is read once', 'The reader reports a missing file'], risk: scenario.risk, revision: 'r1' };
  const flow = { taskSnapshot: task, reviewHistory: [], results: { source: { head: baseHead }, plan: { result: { summary: 'Pinned fictional plan', files: ['records.txt'], checks: [], risks: [] } } }, riskAssessments: [], effectiveRisk: scenario.risk === 'strict' ? 'strict' : 'ordinary', reviewProtocol: scenario.protocol, completionMode: scenario.satisfied ? 'already-satisfied' : 'merge' };
  const captured = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (step.edit) commit(root, 'records.txt', `fictional baseline\n${step.edit} candidate\n`, `${step.edit} candidate`);
    const replies = structuredClone(options.results?.(scenario, index, step) ?? step.results ?? []), calls = [];
    const providerInvoke = async spec => { calls.push({ role: spec.role, prompt: spec.prompt, schema: JSON.stringify(spec.schema), sessionId: spec.sessionId ?? null }); if (spec.role === 'builder') return { provider: 'codex', model: 'fictional-builder', family: 'openai', sessionId: 'builder-session', result: { status: 'implemented', summary: 'Fictional correction', questions: [], assumptions: [], departures: [], unverified: [], pushback: [], learningsApplied: [] } }; return { provider: 'claude', model: 'fictional-reviewer', family: 'anthropic', sessionId: `review-session-${index}-${calls.length}`, result: replies.shift() }; };
    const operation = { review: 'provider.review', build: 'provider.build', plan: 'provider.planReview' }[step.op];
    const binding = step.op === 'review' ? (scenario.satisfied ? 'satisfied-review' : flow.reviewHistory.length ? 'delta-review' : 'review') : step.op === 'plan' ? 'plan-review' : 'build';
    const intent = { cwd: root, timeoutMs: 600000, attemptId: `attempt-${index}`, action: { operation, step: binding, binding, task, config, risk: riskSummary(task, flow), riskAssessments: flow.riskAssessments, reviewHistory: flow.reviewHistory, reviewProtocol: scenario.protocol, completionMode: flow.completionMode, results: flow.results, sessions: {}, context: { files: [], digest: 'fictional-context' }, operatorFeedback: [], carriedQuestions: [], carriedOverflow: null, artifactDir: join(dir, `artifacts-${index}`), projectId: 'project-1', flowId: 'flow-1', workspace: null, ...options.action(scenario, step) } };
    const result = await runAction(intent, { providerInvoke });
    captured.push({ step: index, op: step.op, calls, result });
    if (step.op === 'review') { flow.results.review = result; flow.results[binding] = result; recordReview(flow, binding, result, intent.attemptId); recordRiskAssessment(flow, binding, result, intent.attemptId); }
    if (step.op === 'plan') { flow.results['plan-review'] = result; recordRiskAssessment(flow, 'plan-review', result, intent.attemptId); }
    if (step.op === 'build') flow.results.build = result;
  }
  let requirement;
  try { requirement = strictReviewRequirement(task, flow, repositoryIdentity(root)); } catch (error) { requirement = { refused: error.message }; }
  return { steps: captured, reviewHistory: flow.reviewHistory, riskAssessments: flow.riskAssessments, requirement };
}

// The golden form of a capture: each prompt and schema by its SHA-256 and length (a byte-identical
// text has the same digest), everything else as captured.
const sha = text => createHash('sha256').update(text).digest('hex');
export const goldenView = capture => JSON.parse(JSON.stringify(capture, (key, value) => key === 'calls' ? value.map(call => ({ role: call.role, sessionId: call.sessionId, prompt: { sha256: sha(call.prompt), length: call.prompt.length }, schema: sha(call.schema) })) : value));
