// What an operator needs to decide a merge question, read from the flow record at the time the
// dashboard is built: the candidate commit the question is about, its pull request, the review
// verdict and the check results on that candidate. Nothing here is authority; the answer is still
// bound to the question's subject digest and re-checked by the project.
//
// The context is generic: a project's own merge-question text (item.context, for example the
// commits of an adopted pull request) is shown beside it unchanged.
const SHA = /^[a-f\d]{40,64}$/i;
const sha = value => typeof value === 'string' && SHA.test(value) ? value : null;
const checkRows = checks => (Array.isArray(checks) ? checks : []).filter(row => row && typeof row === 'object').slice(0, 16)
  .map(row => ({ id: String(row.id ?? ''), status: String(row.status ?? 'unknown'), ...(typeof row.failureClass === 'string' ? { failureClass: row.failureClass } : {}) }));
const checkResult = (result, candidate) => result && typeof result === 'object' ? {
  route: typeof result.route === 'string' ? result.route : null,
  head: sha(result.inputIdentity?.head) ?? sha(result.head),
  // A result recorded for another head is shown as such, never as this candidate's.
  current: Boolean(candidate) && (sha(result.inputIdentity?.head) ?? sha(result.head)) === candidate,
  checks: checkRows(result.checks),
} : null;

export function mergeQuestionContext(flow) {
  if (!flow || typeof flow !== 'object') return null;
  const results = flow.results ?? {}, evidence = flow.evidence ?? {};
  // The candidate: the head the gate and review evidence were minted for, else the published or adopted head.
  const candidate = sha(evidence.gate?.head) ?? sha(evidence.review?.head) ?? sha(results.publish?.head) ?? sha(flow.candidate?.head);
  const publish = results.publish && typeof results.publish === 'object' ? results.publish : null;
  const number = Number.isSafeInteger(publish?.number) ? publish.number : Number.isSafeInteger(flow.candidate?.number) ? flow.candidate.number : null;
  const review = results.review && typeof results.review === 'object' ? results.review : null;
  const findings = Array.isArray(review?.result?.findings) ? review.result.findings : [];
  const bySeverity = {}; for (const row of findings) { const key = typeof row?.severity === 'string' ? row.severity : 'unrated'; bySeverity[key] = (bySeverity[key] ?? 0) + 1; }
  return {
    candidate,
    base: sha(results.integrate?.base) ?? sha(flow.candidate?.base) ?? sha(flow.workspace?.base),
    branch: typeof (publish?.branch ?? flow.workspace?.branch) === 'string' ? publish?.branch ?? flow.workspace.branch : null,
    // The pull request merged by this flow: its own publication, or, before one exists, the adopted PR itself.
    pullRequest: number || publish?.url ? { number, url: typeof publish?.url === 'string' ? publish.url : null, adopted: !publish && Boolean(flow.candidate) } : null,
    // An adopted pull request (external PR adoption): the original the candidate came from.
    adoptedFrom: flow.candidate && Number.isSafeInteger(flow.candidate.number) ? { number: flow.candidate.number, head: sha(flow.candidate.head) } : null,
    review: review ? {
      route: typeof review.route === 'string' ? review.route : null,
      verdict: typeof review.result?.verdict === 'string' ? review.result.verdict : null,
      findings: findings.length, bySeverity,
      summary: typeof review.result?.summary === 'string' ? review.result.summary.slice(0, 600) : null,
      phase: typeof review.phase === 'string' ? review.phase : null,
      head: sha(review.identity?.head), current: Boolean(candidate) && sha(review.identity?.head) === candidate,
    } : null,
    gate: checkResult(results.gate, candidate),
    fastChecks: checkResult(results['fast-check'], candidate),
  };
}

// The flow's open merge question, if this inbox item is it.
export function isMergeQuestion(item, flow) {
  return Boolean(item && flow && item.kind === 'question' && !item.standalone && item.status === 'open' && item.flowId === flow.id && flow.workflow?.nodes?.[flow.step]?.mergeDecision);
}
