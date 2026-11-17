import { inspect } from './effects.mjs';
import { cliCommand, shellWord } from './install-layout.mjs';

// What settling an uncertain attempt leads to (dev.84, H9). attempt.resolve (failed or
// not-dispatched) makes resume follow the step's failure route; when that route ends the flow as
// failed, the work so far (a reviewed plan, its review) is not reused and the task needs a new flow.
// Said before the operator settles it: in the stop notice, the resume refusal and the resolve's own
// stop reason. '' when the step has no failure route.
export function failureRouteWarning(flow, step) {
  const next = flow?.workflow?.nodes?.[step]?.onFailure, end = next ? flow.workflow.nodes[next] : null;
  if (!next) return '';
  if (end?.kind === 'end' && end.outcome === 'failed') {
    const kept = [flow.results?.plan?.result ? 'its reviewed plan' : null, flow.results?.review?.result ? 'its review' : null].filter(Boolean);
    return `Settling it (attempt.resolve, failed or not-dispatched) makes resume follow step ${step}'s failure route to ${next}: the flow ends failed${kept.length ? ` and ${kept.join(' and ')} ${kept.length > 1 ? 'are' : 'is'} not reused` : ''}, so the task needs a new flow (task.restart)`;
  }
  return `Settling it (attempt.resolve) makes resume follow step ${step}'s failure route to ${next}`;
}
// Why a stopped flow cannot be resumed yet: its last step's attempt has not settled. Names the
// attempt and step, says why it is unsettled (still running, finished but not yet recorded, or
// an uncertain outcome) and what to run, if anything. Read-only.
export function unsettledAttemptMessage(store, flow) {
  const attempt = store.get('attempt', flow.attemptId);
  const cli = cliCommand(store.meta('project')?.root), state = shellWord(store.stateDir);
  const head = `attempt ${flow.attemptId}${attempt ? ` (step ${attempt.step})` : ''} of flow ${flow.id} has not settled, so the flow cannot resume yet`;
  if (!attempt) return `${head}. Inspect it with ${cli} status --state ${state} --flow ${shellWord(flow.id)}.`;
  let observed;
  try { observed = attempt.status === 'uncertain' ? { kind: 'uncertain', reason: attempt.reason } : inspect(store, attempt); }
  catch (error) { observed = { kind: 'uncertain', reason: error.message }; }
  if (observed.kind === 'running' || observed.kind === 'launching') return `${head}: its process is still running (stop does not end a running step unless it is given abort: true). Nothing needs reconciling: resume again when the step has finished, and its result is used without running it again. To end it now, stop the flow with abort: true, then resume.`;
  if (observed.kind === 'terminal') return `${head}: its process has finished, but the project runner has not recorded the result yet. Nothing needs reconciling: resume again in a moment (check that the runner is running if this persists).`;
  const typed = ['forge.publish', 'forge.merge', 'forge.closeTask', 'integration.run'].includes(attempt.intent?.action?.operation);
  const payload = JSON.stringify({ attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: '<what you inspected>' });
  return `${head}: its outcome is uncertain (${String(attempt.reason ?? observed.reason ?? 'no live process and no receipt').slice(0, 300)}). Inspect ${shellWord(`${store.stateDir}/attempts/${attempt.id}`)} and any external effect, then settle it: ${typed ? `${cli} reconcile --state ${state} --attempt ${shellWord(attempt.id)} --note "<why>" reads the remote outcome; otherwise ` : ''}${cli} command --actor operator --state ${state} --operation attempt.resolve --payload ${shellWord(payload)} (disposition failed or not-dispatched, with the actual cost). Then resume.${(w => w ? ` ${w}.` : '')(failureRouteWarning(flow, attempt.step))}`;
}
