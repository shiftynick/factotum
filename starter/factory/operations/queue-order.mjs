import { assert } from '../core/contracts.mjs';
export function validateQueuePolicy(policy = {}) {
  assert(policy.queueRanking === undefined || typeof policy.queueRanking === 'boolean', 'queueRanking must be boolean');
  assert(policy.categoryOrder === undefined || Array.isArray(policy.categoryOrder) && policy.categoryOrder.every(value => typeof value === 'string' && value) && new Set(policy.categoryOrder).size === policy.categoryOrder.length, 'categoryOrder must contain unique category names');
  assert(policy.categoryLimits === undefined || policy.categoryLimits && typeof policy.categoryLimits === 'object' && !Array.isArray(policy.categoryLimits), 'categoryLimits must be an object');
  for (const [category, limit] of Object.entries(policy.categoryLimits ?? {})) assert(category && Number.isSafeInteger(limit) && limit > 0, 'positive category flow limits required');
  return policy;
}
export function validateQueueMetadata(entries, taskIds) {
  assert(entries === undefined || Array.isArray(entries), 'queue entries must be an array');
  const result = new Map();
  for (const entry of entries ?? []) {
    assert(entry && taskIds.includes(entry.id) && !result.has(entry.id), 'queue metadata must name unique queued tasks');
    assert(Object.keys(entry).every(key => ['id','priority','pinned'].includes(key)), 'unsupported queue metadata field');
    assert(entry.priority === undefined || Number.isSafeInteger(entry.priority) && Math.abs(entry.priority) <= 1000000, 'bounded integer queue priority required');
    assert(entry.pinned === undefined || typeof entry.pinned === 'boolean', 'queue pin must be boolean');
    result.set(entry.id, entry);
  }
  return result;
}
// Pins preserve exact operator positions; ranked items fill only the free slots.
export function orderedQueue(store, policy = store.meta('config', {}).policy ?? {}) {
  validateQueuePolicy(policy);
  const rows = store.live('queue').filter(row => row.status === 'queued').sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
  if (!policy.queueRanking) return rows;
  const categories = policy.categoryOrder ?? [], categoryRank = row => { const position = categories.indexOf(store.get('task', row.id)?.category); return position < 0 ? categories.length : position; };
  const free = rows.filter(row => !row.pinned).sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0) || categoryRank(a) - categoryRank(b) || (a.order ?? 0) - (b.order ?? 0));
  return rows.map(row => row.pinned ? row : free.shift());
}
