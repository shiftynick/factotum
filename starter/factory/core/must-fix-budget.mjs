// The must-fix cap's budget (docs/designs/review-must-fix.md 9.5 and 13.1): the correction cycle of
// a review node, and whether one more cycle still fits the flow's visit and transition bounds.
//
// - The correction cycle of a `provider.review` node is the path from its `revise` edge back to a
//   review node through the first edge of each step (in the reference graph: build, commit,
//   integrate, the fast check when configured, publish, review), and the path from that review to
//   the merge question along `pass` edges.
// - One more cycle fits when every step with a visit bound on the cycle and on the path to the merge
//   question has a visit left (its bound plus its extensions, minus its visits, as move() and
//   publicFlow() in core/project.mjs count them), and the flow's remaining transitions cover the
//   cycle plus the path to the merge question.
//
// Nothing here changes a graph, a bound or a route: a must-fix review reads it before routing
// `revise`, and a must-fix flow's `send_back` reads it before it is accepted. A severity or shadow
// flow never reads it.

import { assert } from './contracts.mjs';

const operation = node => node?.action?.operation ?? null;
const isReview = node => node?.kind === 'effect' && operation(node) === 'provider.review';
// A step's first edge: its first result edge, else its next step.
const firstEdge = node => Object.values(node?.resultEdges ?? {})[0] ?? node?.next ?? null;
const passEdge = node => node?.resultEdges?.pass ?? node?.next ?? null;

// The steps from `from` back to a review node along first edges, the review included; null when the
// path reaches a question, an end, a loop or an unknown step first.
export function correctionPath(workflow, from) {
  const nodes = workflow?.nodes ?? {}, path = [];
  for (let step = from; step; step = firstEdge(nodes[step])) {
    const node = nodes[step];
    if (!node || node.kind !== 'effect' || path.includes(step)) return null;
    path.push(step);
    if (isReview(node)) return path;
  }
  return null;
}
// The steps from a review node to the first question along pass edges, that question included; null
// when there is none. `flag`: the question's decision flag (mergeDecision, satisfiedDecision).
function passPath(workflow, review, flag) {
  const nodes = workflow?.nodes ?? {}, path = [];
  for (let step = passEdge(nodes[review]); step; step = passEdge(nodes[step])) {
    const node = nodes[step];
    if (!node || path.includes(step)) return null;
    path.push(step);
    if (node.kind === 'question') return node[flag] === true ? path : null;
    if (node.kind !== 'effect') return null;
  }
  return null;
}
export const mergePath = (workflow, review) => passPath(workflow, review, 'mergeDecision');
// A satisfied review (6.5) leads to the satisfied question, routes only pass and revise, and has no
// correction cycle: its revise ends the flow.
export const satisfiedReview = (workflow, step) => passPath(workflow, step, 'satisfiedDecision') !== null;

// Every change review node of a graph with its correction cycle and its path to the merge question.
export function correctionCycles(workflow) {
  return Object.entries(workflow?.nodes ?? {}).filter(([step, node]) => isReview(node) && !satisfiedReview(workflow, step)).map(([step, node]) => {
    const cycle = node.resultEdges?.revise ? correctionPath(workflow, node.resultEdges.revise) : null;
    return { step, cycle, toMerge: cycle ? mergePath(workflow, cycle.at(-1)) : null };
  });
}
// Why a graph cannot run must-fix review (13.1, 9.5): a change review node without a `defer` or a
// `park` edge (the route would fail the attempt, core/engine.mjs), or without a correction cycle.
export function mustFixGraphProblems(workflow) {
  const problems = [];
  for (const { step, cycle, toMerge } of correctionCycles(workflow)) {
    const edges = workflow.nodes[step].resultEdges ?? {};
    for (const edge of ['defer', 'park']) if (!edges[edge]) problems.push(`review node ${step} has no ${edge} edge`);
    if (!cycle) problems.push(`review node ${step} has no correction cycle: its revise edge does not lead back to a review through the first edge of each step`);
    else if (!toMerge) problems.push(`review node ${step} has no correction cycle: review ${cycle.at(-1)} does not reach the merge question along pass edges`);
  }
  return problems;
}

// Commissioning refuses `must-fix` for a graph with any of those problems (13.1). The configuration
// cannot select `must-fix` until the enabling release, so until then only fixtures reach this.
export function assertMustFixGraph(name, workflow) {
  const problems = mustFixGraphProblems(workflow);
  assert(!problems.length, `workflow ${name} cannot run must-fix review: ${problems.join('; ')}`);
}

const visitsLeft = (flow, step) => {
  const limit = flow.workflow?.nodes?.[step]?.maxVisits;
  return limit ? limit + (flow.limitExtensions?.[step] ?? 0) - (flow.visits?.[step] ?? 0) : null;
};
const transitionsLeft = flow => (flow.workflow?.maxTransitions ?? 100) + (flow.transitionAllowance ?? 0) - (flow.transitions ?? 0);

// Whether one more correction cycle starting at `from` (a review's revise target, or a send_back's
// target), and the path from it to the merge question, fit the flow's bounds. `flow`: { workflow, visits, limitExtensions, transitions,
// transitionAllowance }. Returns the cycle, the path to the merge question, each bounded step that
// lacks a visit, and the transitions needed and left.
export function cycleBudget(flow, from) {
  const cycle = from ? correctionPath(flow.workflow, from) : null, toMerge = cycle ? mergePath(flow.workflow, cycle.at(-1)) : null;
  if (!cycle || !toMerge) return { fits: false, reason: 'no correction cycle', from: from ?? null, cycle, toMerge };
  // Every bounded step the change passes through, the path to the merge question included (the gate).
  const needed = new Map(); for (const step of [...cycle, ...toMerge]) needed.set(step, (needed.get(step) ?? 0) + 1);
  const short = [...needed].map(([step, visits]) => ({ step, needed: visits, left: visitsLeft(flow, step) })).filter(row => row.left !== null && row.left < row.needed);
  const transitions = { needed: cycle.length + toMerge.length, left: transitionsLeft(flow) };
  const fits = !short.length && transitions.left >= transitions.needed;
  const visitText = short.map(row => `${row.step} (${Math.max(0, row.left)} left, ${row.needed} needed)`).join(', ');
  const reason = fits ? null : short.length ? `no visit left at ${visitText}` : `${transitions.left} transitions left, ${transitions.needed} needed`;
  return { fits, ...(reason ? { reason } : {}), from, cycle, toMerge, short, transitions };
}
