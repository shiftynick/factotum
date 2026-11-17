import { now } from '../core/contracts.mjs';
import { hasUpkeepMarker } from '../core/upkeep-namespace.mjs';

// Flow slots. policy.maxFlows (and policy.maxDocumentFlows for the document pool) bound the
// change and document flows that hold a slot. A flow holds one from admission until it finishes,
// with one exception: a flow parked on an answer.
//
// - Parked: the flow is waiting at a question step (any question node: a plan, build, conflict,
//   review or gate question, a merge decision, a satisfied-outcome decision, a strict sign-off, or
//   a project-owned question), with no attempt and not stopped. It does no work until someone
//   answers, so it holds no slot. This is read from the flow's step and state, not from a stored
//   flag, so a flow that was already waiting on an answer before an upgrade is parked at once.
//   A flow that has reached a question the engine has not opened yet (state ready) still holds its
//   slot: a question answered by policy as it opens (autoMerge) never gives its slot away.
// - The parked allowance: at most policy.maxParkedFlows (default 3) flows are parked without a
//   slot, the longest-parked first. A flow parked beyond that holds a slot again in its own pool,
//   exactly as every waiting flow did before parking existed. 0 turns parking off.
// - Waiting for a slot: a parked flow that was answered (or replanned, or resumed) while every
//   slot of its pool was in use. It holds no slot, does no work and is not stopped; the engine
//   gives it the first free slot, ahead of every queued task. The line: answered merges first (a
//   merge finishes work and frees its worktree and paths), then other flows, each in the order
//   the waits began.
// - Stopped flows hold a slot, whatever they did before the stop.
// - Categories: policy.categoryLimits bounds the flows of a category that hold a place, by the
//   same rules. A parked flow within the allowance holds no place in its category; one beyond it,
//   a working one and a stopped one do; an answered flow needs a place as well as a slot.
//
// Path, area, merge and health exclusions are separate (operations/admission.mjs) and still
// apply to every unfinished flow, parked ones included.
//
// Everything here reads the live flow set (store.live) and nothing else. Live sets may be
// projections without the workflow (the dashboard's facade); the step kind of the few flows that
// could be parked is then read by primary key.
export const DEFAULT_MAX_PARKED_FLOWS = 3;
const finished = flow => ['completed', 'failed'].includes(flow.state);
// The flows that take change or document slots (the set admission has always counted).
export const pooled = flow => !finished(flow) && !['planning', 'maintenance', 'task'].includes(flow.kind);
export const poolOf = flow => flow.pool === 'document' ? 'document' : 'change';

function stepNode(store, flow) {
  if (flow.workflow) return flow.workflow.nodes?.[flow.step] ?? null;
  const row = store?.db?.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('flow', flow.id);
  return row ? JSON.parse(row.data).workflow?.nodes?.[flow.step] ?? null : null;
}
const nodeKind = (store, flow) => stepNode(store, flow)?.kind ?? null;
// Waiting at a question step with nothing running.
export function atQuestion(store, flow) {
  return Boolean(flow) && !finished(flow) && flow.state === 'waiting' && !flow.stopRequested && !flow.attemptId && !flow.slotWait && nodeKind(store, flow) === 'question';
}
export const waitingForSlot = flow => Boolean(flow?.slotWait) && !finished(flow) && flow.state !== 'stopped' && !flow.stopRequested;
const since = flow => String(flow.parkedAt ?? flow.createdAt ?? '');
const byTime = key => (a, b) => key(a).localeCompare(key(b)) || String(a.id).localeCompare(String(b.id));
// The line for free slots: answered merges first, then by when each wait began.
const inLine = (a, b) => Number(b.slotWait?.merge === true) - Number(a.slotWait?.merge === true) || byTime(flow => String(flow.slotWait?.since ?? ''))(a, b);
const categoryOf = (store, flow) => (flow.taskSnapshot ?? store.get('task', flow.taskId))?.category ?? null;

export function limits(policy = {}) {
  return { change: policy.maxFlows ?? policy.maxActiveFlows ?? 1, document: policy.maxDocumentFlows ?? 2, maxParkedFlows: policy.maxParkedFlows ?? DEFAULT_MAX_PARKED_FLOWS, categories: policy.categoryLimits ?? {} };
}

// Who holds what. `except` leaves one flow out, to judge whether there is room for it. A caller
// that has already read the live flow set passes it as `flows`.
export function slots(store, { policy = store.meta('config', {}).policy ?? {}, except, flows: live = store.live('flow') } = {}) {
  const max = limits(policy), flows = live.filter(flow => pooled(flow) && flow.id !== except);
  // Knowledge upkeep follow-ups are counted last in the allowance order (design 7.6): requested work
  // is never pushed over the limit by one.
  const upkeep = flow => hasUpkeepMarker(flow.taskSnapshot ?? store?.get?.('task', flow.taskId));
  const parkedAll = flows.filter(flow => atQuestion(store, flow)).sort((a, b) => Number(upkeep(a)) - Number(upkeep(b)) || byTime(since)(a, b));
  const parkedIds = new Set(parkedAll.map(flow => flow.id));
  // The longest-parked flows use the allowance; later ones hold a slot in their pool.
  const overflowIds = new Set(parkedAll.slice(max.maxParkedFlows).map(flow => flow.id));
  const waitingAll = flows.filter(waitingForSlot).sort(inLine);
  const tally = mine => {
    const working = mine.filter(flow => !parkedIds.has(flow.id) && !waitingForSlot(flow));
    const parked = mine.filter(flow => parkedIds.has(flow.id)), overflow = parked.filter(flow => overflowIds.has(flow.id));
    return { working, stopped: working.filter(flow => flow.state === 'stopped'), parked, overflow, waiting: waitingAll.filter(flow => mine.includes(flow)), held: working.length + overflow.length };
  };
  // Slots nobody holds (`free`).
  const room = (row, limit) => ({ ...row, max: limit, free: Math.max(0, limit - row.held) });
  const pools = Object.fromEntries(['change', 'document'].map(pool => [pool, room(tally(flows.filter(flow => poolOf(flow) === pool)), max[pool])]));
  // Categories with a limit, across both pools. Read only when a limit is configured.
  const limited = Object.keys(max.categories), category = new Map(limited.length ? flows.map(flow => [flow.id, categoryOf(store, flow)]) : []);
  const categories = Object.fromEntries(limited.map(name => [name, room(tally(flows.filter(flow => category.get(flow.id) === name)), max.categories[name])]));
  const state = { maxParkedFlows: max.maxParkedFlows, pools, categories, category, parked: parkedAll, overflowIds, waiting: waitingAll };
  // Waiting flows are first in line for free slots, then queued tasks. A slot (or a category place)
  // is reserved only for a waiting flow that can take it now: one that is waiting for a place in a
  // full category does not hold a pool slot back from other work. It keeps its place in the line
  // for when its category frees.
  state.granted = allocation(state);
  for (const row of [...Object.values(pools), ...Object.values(categories)]) {
    row.reserved = row.waiting.filter(flow => state.granted.has(flow.id));
    row.freeForNewWork = Math.max(0, row.max - row.held - row.reserved.length);
  }
  return state;
}
// Which waiting flows the free slots go to now: the line in order, each taking a slot of its pool
// and, where its category has a limit, a place in it. A flow whose category is full is passed
// over, so it does not hold up the flows behind it.
function allocation(state, line = state.waiting, categoryOfFlow = flow => state.category.get(flow.id)) {
  const free = Object.fromEntries(Object.entries(state.pools).map(([pool, row]) => [pool, row.free])), places = Object.fromEntries(Object.entries(state.categories).map(([name, row]) => [name, row.free]));
  const granted = new Set();
  for (const flow of line) {
    const pool = poolOf(flow), name = categoryOfFlow(flow), bounded = name != null && Object.hasOwn(places, name);
    if (free[pool] <= 0 || bounded && places[name] <= 0) continue;
    free[pool]--; if (bounded) places[name]--; granted.add(flow.id);
  }
  return granted;
}

// The answered flows ahead of queued work for this pool (or category), in line order: those a free
// slot goes to now (`reserved`), and those waiting while every slot is held by working flows, which
// take the next slots to free before any queued task (dev.84, H10). A waiting flow whose own
// category is full is left out: it is passed over until that category frees, so it is not ahead.
export function answeredAhead(state, row) {
  return row.waiting.filter(flow => {
    if (row.reserved.includes(flow)) return true;
    const name = state.category.get(flow.id), place = name != null ? state.categories[name] : null;
    return !place || place.free > 0;
  });
}
// Why a new flow cannot take a slot of this pool, or null. The wording keeps the earlier prefixes.
const clauses = (state, row, noun) => {
  const ahead = answeredAhead(state, row);
  return [
    row.stopped.length ? `stopped flows still hold ${noun}s: ${row.stopped.map(flow => flow.id).join(', ')} (resume, abandon, or task.restart their tasks)` : null,
    row.overflow.length ? `parked flows beyond policy.maxParkedFlows (${state.maxParkedFlows}) hold ${noun}s: ${row.overflow.map(flow => flow.id).join(', ')} (answer their questions)` : null,
    ahead.length ? `answered flows take the next free ${noun} first: ${ahead.map(flow => flow.id).join(', ')}` : null,
  ].filter(Boolean);
};
export function capacityReason(state, pool) {
  const row = state.pools[pool];
  if (row.freeForNewWork > 0) return null;
  return [pool === 'document' ? 'document flow capacity exhausted' : 'flow capacity exhausted', ...clauses(state, row, 'slot')].join('; ');
}
// The same for a category with a limit (policy.categoryLimits). Stopped flows are not named here: the pool reason names them.
export function categoryReason(state, name) {
  const row = name == null ? null : state.categories[name];
  if (!row || row.freeForNewWork > 0) return null;
  return [`category capacity exhausted: ${name}`, ...clauses(state, { ...row, stopped: [] }, 'place')].join('; ');
}

// What a flow waiting for a slot is told, with its place in line. Computed when read, never stored.
export function slotWaitView(state, flow) {
  const pool = poolOf(flow), row = state.pools[pool], position = row.waiting.findIndex(other => other.id === flow.id) + 1;
  const name = state.category.get(flow.id), place = name != null ? state.categories[name] : null;
  const named = holder => [...holder.working.map(other => `${other.id}${other.state === 'stopped' ? ' (stopped)' : ''}`), ...holder.overflow.map(other => `${other.id} (parked beyond policy.maxParkedFlows)`)];
  const slotFull = row.free <= 0, placeFull = Boolean(place) && place.free <= 0;
  const setting = pool === 'document' ? 'policy.maxDocumentFlows' : 'policy.maxFlows';
  const wants = [slotFull || !placeFull ? `a ${pool} flow slot (${row.held} of ${row.max} in use, ${setting})` : null, placeFull ? `a place in category ${name} (${place.held} of ${place.max} in use, policy.categoryLimits)` : null].filter(Boolean).join(' and ');
  const holders = [...new Set([...(slotFull ? named(row) : []), ...(placeFull ? named(place) : [])])];
  const merge = flow.slotWait?.merge === true, others = row.waiting.some(other => other.slotWait?.merge !== true);
  return { flowId: flow.id, taskId: flow.taskId ?? null, pool, category: name ?? null, step: flow.step ?? null, since: flow.slotWait?.since ?? null, after: flow.slotWait?.after ?? null, merge, position, of: row.waiting.length,
    reason: `Waiting for ${wants}: position ${position} of ${row.waiting.length}${merge && others ? ' (an answered merge goes ahead of other waiting flows)' : !merge && row.waiting.some(other => other.slotWait?.merge === true) ? ' (answered merges go first)' : ''}. It continues by itself, ahead of queued tasks, when ${holders.length ? `one of these finishes, parks on a question or is abandoned: ${holders.join(', ')}` : 'the engine next steps it'}.` };
}

// Waiting flows that a full category holds back while their pool has a slot nobody is using: who
// waits, for which category, and what holds it. The slot is not reserved for them (queued work of
// other categories may take it), so this is what explains a slot standing idle.
// The one test for that: a waiting flow, passed over by the allocation, whose category is full while
// its pool has a slot that no waiting flow has been granted. Queue (categoryWaits) and a flow's own
// detail (flowSlot's `category` state) both use it, so they always agree.
export function waitsOnCategoryOnly(state, flow) {
  if (!waitingForSlot(flow) || state.granted.has(flow.id)) return false;
  const pool = state.pools[poolOf(flow)], name = state.category.get(flow.id), place = name != null ? state.categories[name] : null;
  return Boolean(place) && place.free <= 0 && pool.free - pool.reserved.length > 0;
}
export function categoryWaits(state) {
  return state.waiting.filter(flow => waitsOnCategoryOnly(state, flow)).flatMap(flow => {
    const name = state.category.get(flow.id), place = state.categories[name];
    const heldBy = [...place.working.map(other => ({ flowId: other.id, state: other.state })), ...place.overflow.map(other => ({ flowId: other.id, state: 'parked beyond policy.maxParkedFlows' }))];
    return [{ flowId: flow.id, taskId: flow.taskId ?? null, pool: poolOf(flow), category: name, inUse: place.held, max: place.max, heldBy,
      text: `Flow ${flow.id} was answered and waits for a place in category ${name} (${place.held} of ${place.max} in use, policy.categoryLimits), held by ${heldBy.map(row => `${row.flowId} (${row.state})`).join(', ') || 'nothing now'}. A ${poolOf(flow)} flow slot is free meanwhile; queued tasks of other categories can take it.` }];
  });
}

// The summary for queue status, the dashboard and status reads.
export function capacityView(store, options) {
  const state = slots(store, options), title = flow => flow.taskSnapshot?.title ?? null;
  const counts = row => ({ max: row.max, inUse: row.held, working: row.working.length - row.stopped.length, stopped: row.stopped.length, parked: row.parked.length, parkedHoldingSlot: row.overflow.length, waitingForSlot: row.waiting.length, free: row.freeForNewWork });
  return {
    maxParkedFlows: state.maxParkedFlows, parkedCount: state.parked.length, waitingCount: state.waiting.length,
    pools: Object.fromEntries(Object.entries(state.pools).map(([pool, row]) => [pool, counts(row)])),
    // Categories with a limit (policy.categoryLimits): the same counts, of places instead of slots.
    categories: Object.fromEntries(Object.entries(state.categories).map(([name, row]) => [name, counts(row)])),
    parked: state.parked.map(flow => ({ flowId: flow.id, taskId: flow.taskId ?? null, title: title(flow), pool: poolOf(flow), step: flow.step ?? null, since: flow.parkedAt ?? null, holdsSlot: state.overflowIds.has(flow.id) })),
    waiting: state.waiting.map(flow => ({ ...slotWaitView(state, flow), title: title(flow) })),
    // Answered flows held back by a full category while a slot of their pool is free.
    categoryWaits: categoryWaits(state),
  };
}

// One flow's place in the slots, from the same state admission and the Queue card use. `state`:
// - working: it holds a slot of its pool (running, ready, or waiting on anything but an answer);
// - parked: waiting on an answer within policy.maxParkedFlows, so it holds no slot;
// - parked-holding: waiting on an answer beyond policy.maxParkedFlows, so it keeps its slot;
// - waiting: answered (or replanned) and waiting for a slot, with its place in line;
// - category: answered and waiting only for a place in its category (policy.categoryLimits) while
//   its pool has a slot that no waiting flow has been granted (waitsOnCategoryOnly, as Queue lists it);
// - stopped: stopped, and holding its slot until it is resumed, abandoned or restarted.
// Null for a finished flow and for kinds that take no change or document slot.
export function flowSlot(state, flow) {
  if (!flow || !pooled(flow)) return null;
  const pool = poolOf(flow), row = state.pools[pool], name = state.category.get(flow.id) ?? null, place = name != null ? state.categories[name] ?? null : null;
  const base = { flowId: flow.id, pool, inUse: row.held, max: row.max, category: name, maxParkedFlows: state.maxParkedFlows };
  if (waitingForSlot(flow)) {
    const view = slotWaitView(state, flow);
    return { ...base, state: waitsOnCategoryOnly(state, flow) ? 'category' : 'waiting', holdsSlot: false, position: view.position, of: view.of, merge: view.merge, since: view.since, reason: view.reason,
      ...(place ? { categoryInUse: place.held, categoryMax: place.max } : {}) };
  }
  const parkedAt = state.parked.findIndex(other => other.id === flow.id);
  if (parkedAt >= 0) {
    const holds = state.overflowIds.has(flow.id);
    return { ...base, state: holds ? 'parked-holding' : 'parked', holdsSlot: holds, parkedPosition: parkedAt + 1, parkedCount: state.parked.length, since: flow.parkedAt ?? null };
  }
  return { ...base, state: flow.state === 'stopped' ? 'stopped' : 'working', holdsSlot: true };
}
// The same for one flow read by ID (flow detail). Reads the live flow set, as queue status does.
export function flowCapacity(store, flow, options) {
  return flow && pooled(flow) ? flowSlot(slots(store, options), flow) : null;
}

// A flow that leaves a question (an answer, a replan) or a stop (a resume) and is about to work
// takes a slot now if its pool (and its category, where limited) has one for it, and otherwise
// waits for one. Call inside the caller's transaction, after the flow has moved to its next
// step. `ahead` is false only for a resumed flow, which was stopped and so already held its slot:
// it does not join the line behind waiting flows. Returns true when the flow may work.
export function takeSlot(store, flow, { after, ahead = true } = {}) {
  if (!pooled(flow)) return true;
  const node = stepNode(store, flow), kind = node?.kind ?? null;
  // A question parks again and an end node finishes: neither does work.
  if (kind === 'question' || kind === 'end' || !kind) { if (flow.slotWait) { delete flow.slotWait; store.put('flow', flow); } return true; }
  const state = slots(store, { except: flow.id }), row = state.pools[poolOf(flow)], name = Object.keys(state.categories).length ? categoryOf(store, flow) : null, place = name != null ? state.categories[name] : null;
  // Its place in the line if it has to wait: an answered merge goes ahead of other waiting flows.
  const wait = { since: flow.slotWait?.since ?? now(), step: flow.step, after: after ?? flow.slotWait?.after ?? null, ...(node.action?.operation === 'forge.merge' ? { merge: true } : {}) };
  const candidate = { ...flow, slotWait: wait };
  const fits = ahead
    ? allocation(state, [...state.waiting, candidate].sort(inLine), other => other.id === flow.id ? name : state.category.get(other.id)).has(flow.id)
    : row.held < row.max && (!place || place.held < place.max);
  if (fits) { if (flow.slotWait) { delete flow.slotWait; store.put('flow', flow); } return true; }
  flow.slotWait = wait; flow.state = 'waiting'; store.put('flow', flow);
  store.event('flow.slot-wait', { flowId: flow.id, taskId: flow.taskId, step: flow.step, pool: poolOf(flow), after: wait.after, inUse: row.held, max: row.max, ...(wait.merge ? { merge: true } : {}), ...(place ? { category: name, categoryInUse: place.held, categoryMax: place.max } : {}) });
  return false;
}
// Engine: is it this waiting flow's turn? Read-only; the grant itself is made in a transaction.
export function slotGrantable(store, flow) {
  return allocation(slots(store)).has(flow.id);
}
export function grantSlot(store, flow) {
  const waited = flow.slotWait; delete flow.slotWait;
  if (flow.state === 'waiting') flow.state = 'ready';
  store.put('flow', flow); store.event('flow.slot-granted', { flowId: flow.id, taskId: flow.taskId, step: flow.step, pool: poolOf(flow), since: waited?.since ?? null });
}
