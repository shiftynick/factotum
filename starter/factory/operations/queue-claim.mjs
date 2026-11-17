// The operations tick's automatic claim (policy.autoQueue): at most one flow admitted per tick, as
// before. A task that passes every admission reason but is refused at final admission (a check only
// admitFlow makes, such as a stored model choice that no longer validates) no longer stops the claim:
// its transaction rolls back, and the claim moves on to the next eligible task in queue order
// (review of 56d49a9, decision 4). Each refused task is recorded once, as a queue hold
// (tick problem `queue-claim:<taskId>`), and again only when its reason changes.
//
// A task's refusal stays open until the task is claimed, leaves the queue, or is held by an ordinary
// admission reason (which the queue already shows). A task not tried this tick because an earlier one
// was admitted keeps its record unchanged, so a refusal that persists is never written twice.
import { admissionReasons, claimCandidate } from './admission.mjs';
import { orderedQueue } from './queue-order.mjs';
import { clearTickProblem, openTickProblems, recordTickProblem } from './tick-problems.mjs';

export const CLAIM_PROBLEM = 'queue-claim:';
export function claimQueue(store, { admit, nowMs = Date.now() } = {}) {
  const refused = new Map(), limit = orderedQueue(store).length + 1;
  let flow = null;
  for (let tried = 0; tried < limit; tried++) {
    try { flow = claimCandidate(store, { exclude: new Set(refused.keys()), nowMs, admit }); break; }
    catch (error) {
      const taskId = error?.taskId;
      // A refusal that names no task (or the same task again) cannot be passed over: record it and stop.
      if (!taskId || refused.has(taskId)) { recordTickProblem(store, `${CLAIM_PROBLEM}*`, 'queue.held', error?.message ?? String(error)); return { flow: null, refused }; }
      refused.set(taskId, error.message);
    }
  }
  clearTickProblem(store, `${CLAIM_PROBLEM}*`);
  for (const [taskId, reason] of refused) recordTickProblem(store, `${CLAIM_PROBLEM}${taskId}`, 'queue.held', reason, { taskId });
  // Refusals of tasks that were claimed, left the queue, or are now held by an ordinary reason.
  for (const [key, row] of openTickProblems(store, CLAIM_PROBLEM)) {
    if (key === `${CLAIM_PROBLEM}*` || refused.has(row.taskId)) continue;
    const queued = store.get('queue', row.taskId)?.status === 'queued', task = queued ? store.get('task', row.taskId) : null;
    if (!queued || flow?.taskId === row.taskId || admissionReasons(store, task, { nowMs }).length) clearTickProblem(store, key);
  }
  return { flow, refused };
}
