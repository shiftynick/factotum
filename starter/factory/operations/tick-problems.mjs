// A problem the operations or engine tick meets on every tick until someone acts (a queued task the
// claim cannot start, a sweep that keeps failing) is recorded once: when it starts, and again only
// when its reason changes. An unchanged problem writes nothing, neither an event nor a record, so a
// hold that lasts a day leaves one event, not one a second (dev.91, O5).
//
// The open problems live in one meta row, `tickProblems` ({key: {type, reason, since, ...fields}}),
// read by key, so they survive a restart and the queue status can show them. A problem ends when the
// same work next succeeds (clearTickProblem); recurring later, it is recorded again.
//
// Only the ticks write the row, so each Store keeps what it last read or wrote: an idle tick adds no
// statement (the first tick of a process reads the row once). A write inside a caller's transaction
// forgets the copy instead, since that transaction may still roll back.
const META = 'tickProblems', known = new WeakMap();
// The open problems as stored (queue status reads this, never the copy).
export const tickProblems = store => store.meta(META, {}) ?? {};
const open = store => { if (!known.has(store)) known.set(store, tickProblems(store)); return known.get(store); };
// The same problem is the same event type, reason and identifying fields (the task, flow or job it is
// about): a refusal of another task with the same words is a new problem (review of 56d49a9, P2).
const same = (previous, type, text, fields) => previous?.type === type && previous.reason === text
  && JSON.stringify(Object.entries(fields).sort()) === JSON.stringify(Object.entries(previous).filter(([name]) => !['type', 'reason', 'since'].includes(name)).sort());
export function recordTickProblem(store, key, type, reason, fields = {}, { at = new Date().toISOString() } = {}) {
  const text = String(reason ?? ''), previous = open(store)[key];
  if (same(previous, type, text, fields)) return false;
  const row = { type, reason: text, since: at, ...fields };
  write(store, () => { const next = { ...tickProblems(store), [key]: row }; store.setMeta(META, next); store.event(type, { reason: text, ...fields }); return next; });
  return true;
}
// The open problems whose key starts with a prefix (the per-task claim refusals), from this store's copy.
export const openTickProblems = (store, prefix) => Object.entries(open(store)).filter(([key]) => key.startsWith(prefix));
export function clearTickProblem(store, key) {
  if (!open(store)[key]) return false;
  write(store, () => { const { [key]: _, ...rest } = tickProblems(store); store.setMeta(META, rest); return rest; });
  return true;
}
function write(store, body) {
  if (store.db?.isTransaction === true) { body(); known.delete(store); return; }
  known.set(store, store.tx(body));
}
