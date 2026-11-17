// Knowledge upkeep: closing the pull request of a follow-up the factory ended (knowledge-upkeep
// design 7.6; review of 292d317, P2-3).
//
// When the factory ends a docs follow-up that has published a pull request (a drain, a stale pin, a
// moved base, a question, the parked allowance, its invocations, a stop, or a failed end), the pull
// request is closed with a comment. The close is a forge effect, so it never runs inside the
// database transaction that ends the flow: that transaction records a request on the flow and
// queues a maintenance job (`forge.closeFollowUp`), which runs as a recorded attempt like any other
// forge effect, with the existing handling of an uncertain outcome (attempt.resolve). The request is
// tracked in the upkeepWork meta row, which the operations tick already reads, until the close is
// done: a job that is revoked (a configuration change), fails or is abandoned is queued again, at
// most UPKEEP_CLOSE_ATTEMPTS times; after that, or when the forge shows a pull request the factory
// must not close, an operator to-do says what to do.
//
// Only the pull request the factory itself published for that follow-up is ever closed: the
// request is made only from the flow's own publish result (number, head and branch), and the
// action closes it only if its body carries the factory's creation marker for that flow and its
// head and branch are the ones the factory pushed (adapters/github/index.mjs closeFollowUpPR).
// This module reads records by key and the one meta row; it starts no process.
import { now } from '../core/contracts.mjs';
import { hasUpkeepMarker } from '../core/upkeep-namespace.mjs';
import { trackUpkeepCloseInTransaction } from './upkeep-records.mjs';

export const UPKEEP_CLOSE_OPERATION = 'forge.closeFollowUp';
export const UPKEEP_CLOSE_ATTEMPTS = 3;
const OBJECT_ID = /^[a-f\d]{40,64}$/i;
// The pull request this flow published, from its own publish result, or null. `factory` says the
// factory itself opened it (created, or found again after a lost response, by its own GitHub
// identity from the configured repository: adapters/github/index.mjs createPR); only such a pull
// request is ever closed automatically (review of e73ae9e, P2-1).
export function publishedPullRequest(flow) {
  const row = flow?.results?.publish;
  if (!(row && Number.isSafeInteger(row.number) && row.number > 0)) return null;
  const factory = OBJECT_ID.test(row.head ?? '') && typeof row.branch === 'string' && row.branch.length > 0 && typeof row.author === 'string' && row.author.length > 0 && typeof row.headRepository === 'string' && row.headRepository.length > 0 && ['created', 'reconciled'].includes(row.createdBy);
  return { number: row.number, head: row.head ?? null, branch: row.branch ?? null, author: row.author ?? null, headRepository: row.headRepository ?? null, createdBy: row.createdBy ?? null, factory };
}
function queueClose(store, flow, request, nowAt = now()) {
  const tries = (request.jobs?.length ?? 0) + 1, jobId = `upkeep-close:${flow.id}:${tries}`;
  store.put('job', { id: jobId, operation: UPKEEP_CLOSE_OPERATION, payload: { flowId: flow.id, projectId: store.meta('project').projectId, number: request.number, head: request.head, branch: request.branch, author: request.author, headRepository: request.headRepository, reason: request.reason }, grant: { actor: 'operator', source: 'configuration', policy: 'upkeep.mode', note: `Close pull request #${request.number}, which the factory published for knowledge upkeep follow-up ${flow.id} and then ended (design 7.6)`, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: nowAt });
  trackUpkeepCloseInTransaction(store, flow.id, jobId);
  store.event('upkeep.pr-close-queued', { flowId: flow.id, number: request.number, jobId, attempt: tries });
  return { ...request, jobs: [...(request.jobs ?? []), jobId] };
}
const needsOperator = (store, flow, request, why) => {
  const id = `upkeep-pr-close:${flow.id}`;
  if (!store.get('obligation', id)) store.put('obligation', { id, flowId: flow.id, title: `Close pull request #${request.number} of the ended knowledge upkeep follow-up`, evidence: why, status: 'pending', owner: 'operator', createdAt: now() });
  return { ...request, status: 'needs-operator', reason: request.reason, detail: why };
};
// In the transaction that ends a follow-up: record the request and queue the first job. Nothing is
// done for a flow that published nothing, or that is not an upkeep follow-up.
export function requestFollowUpCloseInTransaction(store, flow, { reason }) {
  const published = publishedPullRequest(flow);
  if (!published || !hasUpkeepMarker(flow.taskSnapshot) || flow.upkeepPullRequest) return null;
  const { factory, ...request } = published;
  // A pull request the factory did not record as its own (adopted, or published before this was
  // recorded) is never closed automatically: the operator is told at once.
  flow.upkeepPullRequest = factory ? queueClose(store, flow, { ...request, reason, status: 'closing', requestedAt: now(), jobs: [] })
    : needsOperator(store, flow, { ...request, reason, requestedAt: now(), jobs: [] }, `The factory has no record that it opened pull request #${request.number} itself, so it does not close it.`);
  store.put('flow', flow);
  return flow.upkeepPullRequest;
}
// The tick, for each tracked close: done, still in hand, queued again, or handed to the operator.
export function upkeepCloseTickInTransaction(store, closes) {
  const done = [];
  for (const { flowId, jobId } of closes) {
    const flow = store.get('flow', flowId), job = store.get('job', jobId), request = flow?.upkeepPullRequest;
    if (!flow || !request) { trackUpkeepCloseInTransaction(store, flowId, null); continue; }
    if (job && ['queued', 'running'].includes(job.status)) continue;
    const result = job?.flowId ? store.get('flow', job.flowId)?.results?.run : null;
    let next;
    if (job?.status === 'completed' && ['closed', 'already-closed'].includes(result?.route)) next = { ...request, status: result.route, closedAt: now() };
    else if (job?.status === 'completed' && result?.route === 'refused') next = needsOperator(store, flow, request, `The factory did not close it: ${result.reason ?? 'the forge does not show the pull request it published'}.`);
    // Closed by the factory once and reopened by someone: never closed again (review of e73ae9e, P2-2).
    else if (job?.status === 'completed' && result?.route === 'reopened') next = { ...needsOperator(store, flow, request, `The factory did not close it again: ${result.reason ?? 'it was reopened after the factory closed it'}.`), status: 'reopened' };
    else if ((request.jobs?.length ?? 0) < UPKEEP_CLOSE_ATTEMPTS) { next = queueClose(store, flow, request); store.put('flow', { ...flow, upkeepPullRequest: next }); done.push({ flowId, action: 'requeued' }); continue; }
    else next = needsOperator(store, flow, request, `Closing it failed ${UPKEEP_CLOSE_ATTEMPTS} times (last job ${jobId}: ${job?.status ?? 'missing'}${job?.reason ? `, ${job.reason}` : ''}).`);
    store.put('flow', { ...flow, upkeepPullRequest: next }); trackUpkeepCloseInTransaction(store, flowId, null);
    store.event('upkeep.pr-close-settled', { flowId, number: request.number, status: next.status }); done.push({ flowId, action: next.status });
  }
  return done;
}
// The comment the closed pull request carries: factory text and identifiers only.
export const closeComment = ({ flowId, reason }) => `Factotum closed this pull request: its knowledge upkeep follow-up (flow ${flowId}) was ended by the factory (${reason}). Nothing in it was merged. The candidates it carried are in the factory's Health view.`;
