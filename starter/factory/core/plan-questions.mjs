import { digest } from './contracts.mjs';
import { PLAN_PROCEED, planQuestionSteps } from './operations.mjs';
import { effectiveRisk, assessmentComplete } from './risk.mjs';
import { boundedText as clean } from './text.mjs';
import { assumptionsOf, boundedContext } from './worker-questions.mjs';

// A question the planner's result routed to (the reference graph's plan-question). Its inbox
// item carries what the planner asked, so the operator can decide from the item alone.
export const isPlanQuestion = (workflow, step) => planQuestionSteps(workflow).includes(step);
// The plan the question is about; "proceed" is refused once it is no longer this plan.
export const planDigest = flow => digest(flow.results?.plan ?? null);
// What a plan says, without how it was produced: the plan report the plan reviewer and the builder
// receive (result), and what it was planned against (the task revision, the governing context and
// the base identity). Invocation metadata (provider, model, session, usage, cost, timing, attempt)
// is left out, so a replan that returns the same plan in a new session is the same plan (review of
// 10cd727: M3 counted a new sessionId as a changed plan).
// The governing context is the whole manifest the context guards read (operations/context.mjs):
// the delivered files and their digests, the omitted entries and why, and every entry's definition
// and content digest, including a mapped file the plan's own scope delivers later. The package
// digest alone leaves out an omitted file's contents, so a changed rule the build would receive
// counted as no change (re-check of 0208a44).
const byId = rows => (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object').map(row => [String(row.id), row]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const governingEvidence = manifest => !manifest || typeof manifest !== 'object' ? null : {
  digest: manifest.digest ?? null,
  files: byId(manifest.files).map(([id, row]) => ({ id, path: row.path ?? null, digest: row.digest ?? null })),
  omitted: byId(manifest.omitted).map(([id, row]) => ({ id, reason: row.reason ?? null })),
  entries: Object.keys(manifest.entries && typeof manifest.entries === 'object' ? manifest.entries : {}).sort().map(id => ({ id, definition: manifest.entries[id]?.definition ?? null, digest: manifest.entries[id]?.digest ?? null })),
};
export const planContentDigest = plan => digest(plan && typeof plan === 'object' ? { result: plan.result ?? null, taskRevision: plan.taskRevision ?? null, contextDigest: plan.contextDigest ?? null, contextManifest: governingEvidence(plan.contextManifest), identity: plan.identity ?? null, targetBase: plan.targetBase ?? null } : null);
// Answers that send the flow from a plan question back to planning without using a plan attempt,
// per plan cycle (flow.replan starts a new cycle). Later ones count against the plan bound.
export const PLAN_CLARIFICATIONS = 3;

// A planner's report is model output: shown as text, bounded, without terminal or control characters.
const MAX_QUESTIONS = 10, QUESTION_CHARS = 1000, SUMMARY_CHARS = 1500, RATIONALE_CHARS = 1000, MAX_PROPOSALS = 5, PROPOSAL_CHARS = 500;

// "Proceed with this plan" is offered, and accepted, only for a plan the planner marked ready
// whose only obstacle is its own questions: the same risk rule as a ready plan without
// questions (strict work needs a complete threat model and stop conditions). The plan still
// goes to plan review, and a strict merge still needs its sign-off.
export function proceedable(task, flow) {
  const result = flow.results?.plan?.result;
  if (result?.status !== 'ready' || !Array.isArray(result.questions) || !result.questions.length) return false;
  return effectiveRisk(task, flow) !== 'strict' || Boolean(assessmentComplete(result.riskAssessment));
}

const LABELS = {
  replan: { label: 'Replan with my answers', description: 'Send a note that answers the planner’s questions. The planner plans again with it.' },
  [PLAN_PROCEED]: { label: 'Proceed with this plan', description: 'Send this plan to plan review as it is. Its questions stay unanswered unless you add a note, and are listed on the merge question; a note reaches the plan reviewer and the builder.' },
  stop: { label: 'Stop flow', description: 'Stop this flow. Its workspace and capacity stay held until you recover or abandon it.' },
};

// The plan question's item fields: the answers it offers (proceed only for a proceedable plan),
// readable labels, the planner's questions, options and risk, and how to answer.
export function planQuestionItem(task, flow, node) {
  const plan = flow.results?.plan, result = plan?.result ?? {};
  const offered = proceedable(task, flow);
  const transitions = Object.fromEntries(Object.entries(node.answers).filter(([answer]) => answer !== PLAN_PROCEED || offered));
  const all = Array.isArray(result.questions) ? result.questions : [];
  const questions = all.slice(0, MAX_QUESTIONS).map(q => clean(q, QUESTION_CHARS)).filter(Boolean);
  const proposals = (Array.isArray(result.pushback) ? result.pushback : []).slice(0, MAX_PROPOSALS).map(row => clean(`${row?.ruleId ?? 'rule'}: ${row?.proposal ?? ''}${row?.cost ? ` (cost of the rule: ${row.cost})` : ''}`, PROPOSAL_CHARS));
  const assessment = result.riskAssessment ?? null, level = effectiveRisk(task, flow);
  const risk = { level, escalated: task?.risk === 'ordinary' && level === 'strict', ...(assessment?.rationale ? { rationale: clean(assessment.rationale, RATIONALE_CHARS) } : {}), ...(level === 'strict' ? { complete: Boolean(assessmentComplete(assessment)) } : {}) };
  const ready = result.status === 'ready';
  const free = Math.max(0, PLAN_CLARIFICATIONS - (flow.planClarifications ?? 0));
  const cost = free ? `This replan does not use one of the plan attempts (${free} such answer${free === 1 ? '' : 's'} left in this plan cycle).` : 'This plan cycle’s free clarifications are used up, so this replan uses a plan attempt; at the plan bound only flow.replan or stop remain.';
  // The opening line, the risk and how to answer are always shown in full; the planner's
  // questions, summary and proposals share what is left of the bound and are cut first.
  // A ready plan whose only questions are assumptions does not stop here (dev.83); one that still
  // lists questions does, with proceed offered. The assumptions are shown either way.
  const allAssumptions = assumptionsOf(result), assumptions = allAssumptions.slice(0, MAX_QUESTIONS);
  const head = plan ? (ready ? (all.length ? `The planner marked its plan ready but left ${all.length} question${all.length === 1 ? '' : 's'} open.` : 'The planner marked its plan ready, but it cannot go on as it is.') : `The planner could not finish the plan and asks ${all.length} question${all.length === 1 ? '' : 's'}.`) : 'The planner’s result is not available.';
  const tail = [
    ...(level === 'strict' ? [`Risk: strict${risk.escalated ? ', escalated by the planner from ordinary' : ''}.${risk.rationale ? ` ${risk.rationale}` : ''}${risk.complete ? '' : ' The threat model or stop conditions are incomplete, so this plan cannot proceed as it is.'}`] : []),
    `How to answer: choose replan with a note that answers these questions. The note reaches the next planner, the plan reviewer and the builder. ${cost}${offered ? ' Or choose proceed to send this plan to plan review as it is, with a note for any answers.' : ''} Do not edit the task to answer: a task edit revokes its approval and stops this flow.`,
  ].join('\n');
  const body = [
    ...(questions.length ? ['Questions:', ...questions.map((q, i) => `${i + 1}. ${q}`), ...(all.length > questions.length ? [`(${all.length - questions.length} more in the plan attempt’s result)`] : [])] : []),
    ...(result.summary ? [`Plan summary: ${clean(result.summary, SUMMARY_CHARS)}`] : []),
    ...(assumptions.length ? ['Answers the plan assumes for questions the planner does not consider blocking (they go on with the plan unless your note says otherwise):', ...assumptions.map(row => `- ${row.question} Assumed: ${row.assumption}`), ...(allAssumptions.length > assumptions.length ? [`(${allAssumptions.length - assumptions.length} more assumptions in the plan attempt’s result)`] : [])] : []),
    ...(proposals.length ? ['Proposed changes to governing rules:', ...proposals.map(p => `- ${p}`)] : []),
  ].join('\n');
  return {
    transitions, answers: Object.keys(transitions),
    choices: Object.keys(transitions).map(answer => ({ id: answer, ...(LABELS[answer] ?? { label: answer }), ...(answer === 'replan' ? { description: `${LABELS.replan.description} ${cost}` } : {}) })),
    context: boundedContext(head, body, tail, 'planQuestion'),
    planQuestion: { planDigest: planDigest(flow), status: ready ? 'ready' : 'blocked', freeClarifications: free, questions, ...(all.length > questions.length ? { omittedQuestions: all.length - questions.length } : {}), assumptions, ...(allAssumptions.length > assumptions.length ? { omittedAssumptions: allAssumptions.length - assumptions.length } : {}), summary: result.summary ? clean(result.summary, SUMMARY_CHARS) : null, proposals, risk, proceedable: offered },
  };
}
