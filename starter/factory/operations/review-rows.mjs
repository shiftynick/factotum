// Review rows (docs/designs/review-must-fix.md 6.2, slice 4): when a must-fix flow's review settles,
// the engine writes a `finding` row with source `review` for each operator item and follow-up in its
// ledger, in the same transaction that records the review, keyed by a digest of the flow id and the
// ledger id. A must-fix flow exists only in test fixtures until the enabling release.
//
// - The row's lifecycle is the finding lifecycle's (operations/upkeep-candidates.mjs): it is created
//   `unapproved` and becomes work only as a task, approved like any task. The design names an
//   operator item's status `needs-operator`; the lifecycle has no such status (accept and decline
//   forms would refuse it), so an operator item is an `unapproved` row with `needs: 'operator'`, and
//   only the operator may act on it (findingAuthority).
// - A row that exists is never moved by a later review: only its descriptive fields (kind, reason,
//   support, claim digest) follow the ledger, so a row a person declined stays declined.
// - At most policy.review.maxFollowupsPerFlow rows per flow. The rest are counted on the flow
//   (`reviewRowOverflow`), and an overflow is itself an operator item, so nothing is dropped unseen.
// - An upkeep-origin flow records rows only; the factory never opens an issue or creates a task from them.
import { digest, now } from '../core/contracts.mjs';
import { hasUpkeepMarker } from '../core/upkeep-namespace.mjs';

export const REVIEW_ROW_SOURCE = 'review';
export const REVIEW_ROW_STATUSES = Object.freeze(['operator-item', 'follow-up', 'operator-accepted']);
export const reviewRowId = (flowId, ledgerId) => digest({ flowId, ledgerId });

export function recordReviewRowsInTransaction(store, flow) {
  const max = flow.reviewPolicy?.maxFollowupsPerFlow ?? 20, upkeep = hasUpkeepMarker(flow.taskSnapshot);
  flow.reviewRows ??= [];
  for (const entry of flow.reviewLedger?.entries ?? []) {
    if (!REVIEW_ROW_STATUSES.includes(entry.status)) continue;
    const id = reviewRowId(flow.id, entry.id), old = store.get('finding', id);
    const fields = { flowId: flow.id, taskId: flow.taskId, ledgerId: entry.id, reviewKind: entry.kind, reason: entry.reason, support: entry.support ?? null, claimDigest: entry.claimDigest ?? null, purposeImpact: entry.purposeImpact ?? null, operatorOnly: entry.operatorOnly === true, needs: entry.kind === 'operator-item' ? 'operator' : null, ...(entry.status === 'operator-accepted' ? { operatorAccepted: true } : {}), ...(upkeep ? { upkeepOrigin: true } : {}) };
    if (old) { if (old.source === REVIEW_ROW_SOURCE) store.put('finding', { ...old, ...fields, lastObservedAt: now() }); else store.event('review.finding-collision', { id, flowId: flow.id, ledgerId: entry.id }); continue; }
    if (flow.reviewRows.length >= max) {
      const ids = [...new Set([...(flow.reviewRowOverflow?.ids ?? []), entry.id])];
      flow.reviewRowOverflow = { count: ids.length, ids: ids.slice(-50), max };
      continue;
    }
    const at = now(), title = `${entry.id} ${entry.kind} (${entry.reason}): ${entry.message ?? entry.scenario ?? 'a finding the factory added for unmet purpose'}`.slice(0, 300);
    store.put('finding', { id, source: REVIEW_ROW_SOURCE, status: 'unapproved', approved: false, version: 1, createdAt: at, lastObservedAt: at, observations: 1, title, evidence: String(entry.scenario ?? entry.message ?? entry.reason).slice(0, 1200), ...fields });
    flow.reviewRows.push(entry.id);
    store.event('review.finding', { id, flowId: flow.id, ledgerId: entry.id, kind: entry.kind });
  }
}
