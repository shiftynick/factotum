// Learnings: usage counters and the retirement check (knowledge-upkeep design 4.1, 11.3, 11.4; slice 8).
//
//   recordLearningSelectionInTransaction  a flow pinned a selection: each selected learning is
//                                         counted as selected once per flow (learningUse)
//   recordLearningCitationsInTransaction  a plan, build or review result cited learnings of its
//                                         selection: each is counted as cited once per flow
//   runLearningsCheck                     the read-only job `learnings.check` (its action): the
//                                         learnings store at the recorded target head, and which
//                                         typed conditions fire for each entry. Reads Git only
//   settleLearningsCheckInTransaction     its settlement: `unused` judged from the counters (by key),
//                                         one `learning-stale` candidate raised per learning and
//                                         condition (propose only), and an open candidate whose
//                                         learning is gone, or whose condition no longer fires,
//                                         resolved elsewhere. Nothing is deleted: a retirement is
//                                         a reviewed `learning-retire` task a person accepts.
//
// Reads are by key (learningUse, finding by class key) and the open upkeep candidates' own partial
// index (4.5); nothing reads a whole kind.
import { now } from '../core/contracts.mjs';
import { upkeepMode } from '../core/upkeep-config.mjs';
import { VerifiedObjects } from '../core/verified-git.mjs';
import { readLearningStore, staleConditions } from './learnings.mjs';
import { isUpkeepCandidate, observeStaleLearningInTransaction, raiseCandidatesInTransaction, resolveFindingElsewhereInTransaction } from './upkeep-candidates.mjs';
import { staleLearningClassKey } from './upkeep-class-key.mjs';
import { UPKEEP_META, UpkeepAccessUnavailable, addLearningUseInTransaction, addToLearningDeliveryInTransaction, learningDelivery, learningUse, openUpkeepCandidates, putLearningsStoreStatusInTransaction } from './upkeep-records.mjs';
import { cleanEvidenceText } from './upkeep-evidence.mjs';

// A learning selected in at least this many flows and never cited is unused (11.4).
export const UNUSED_SELECTIONS = 10;
const OBJECT_ID = /^([a-f\d]{40}|[a-f\d]{64})$/, LEARNING = /^learning-[a-f0-9]{12}$/;
// What a flow has counted, so that a flow counts each learning once however many cycles it runs.
const counted = (flow, field) => new Set(Array.isArray(flow.learningUse?.[field]) ? flow.learningUse[field] : []);
// A flow's record of what it counted: `selected` and `cited` (each learning once per flow), and
// `windows`, the delivery window (its generation) each selection was counted in.
function count(store, flow, field, ids) {
  const seen = counted(flow, field), fresh = [...new Set(ids)].filter(id => LEARNING.test(id) && !seen.has(id)).slice(0, 40);
  for (const id of fresh) addLearningUseInTransaction(store, id, { [field]: 1 });
  const windows = { ...(flow.learningUse?.windows ?? {}) }, generation = learningDelivery(store).generation;
  // The totals the 14.3 criterion is judged on (operations/upkeep-records.mjs learningDelivery): a
  // selection in the current window, and a citation only when its learning's selection was counted
  // in that same window (review of 004f4ab, P2-2).
  if (field === 'selected') { for (const id of fresh) windows[id] = generation; if (fresh.length) addToLearningDeliveryInTransaction(store, { selected: fresh.length }); }
  else if (fresh.length) { const inWindow = fresh.filter(id => windows[id] === generation).length; addToLearningDeliveryInTransaction(store, { cited: inWindow, late: fresh.length - inWindow }); }
  if (fresh.length) flow.learningUse = { selected: [...counted(flow, 'selected')], cited: [...counted(flow, 'cited')], [field]: [...seen, ...fresh].slice(-200), windows: Object.fromEntries(Object.entries(windows).slice(-200)) };
  return fresh;
}
// The caller writes the flow.
export const recordLearningSelectionInTransaction = (store, flow, selection) => count(store, flow, 'selected', (selection?.entries ?? []).map(entry => entry.id));
export const recordLearningCitationsInTransaction = (store, flow, ids) => count(store, flow, 'cited', ids);

// Whether one learning's named condition fires now: true, false, or null when it cannot be judged
// (the tree walk was cut short). `entry` is { id, path, blob, fields } as read at `commit`.
// Acceptance (operations/upkeep-tasks.mjs) and the retire flow's pin check use it, so a candidate is
// never acted on once its condition has cleared (review of b46da01, P2-2 and Q5).
export function staleConditionFires(store, { objects, commit, config, entry, condition }) {
  if (condition === 'unused') { const use = learningUse(store, entry.id); return use.selected >= UNUSED_SELECTIONS && use.cited === 0; }
  const [row] = staleConditions({ objects, commit, config, store: { entries: [entry] } }).rows;
  return row.fired.includes(condition) ? true : row.unjudged?.includes(condition) ? null : false;
}

// ---- The job's action: Git only ----
// `head` is the target head the factory last recorded. Returns the job's result.
export function runLearningsCheck({ root, config, head }) {
  if (!OBJECT_ID.test(head ?? '')) return { route: 'pass', learningsCheck: { skipped: 'no target head is recorded; verify the target (main.verify) first' } };
  const objects = new VerifiedObjects(root), store = readLearningStore({ objects, commit: head, config });
  if (store.problem) return { route: 'pass', learningsCheck: { head, dir: store.dir, problem: store.problem, entries: [], refused: store.refused } };
  const judged = staleConditions({ objects, commit: head, config, store });
  return { route: 'pass', learningsCheck: { head, dir: store.dir, entries: judged.rows, refused: store.refused.slice(0, 40), walked: judged.walked, complete: judged.complete } };
}

// ---- Settlement ----
// `result` is the job's own learningsCheck (a privileged field of its operation). In `propose`, each
// condition that fires raises one candidate (a class key per learning and condition, 4.2), and an
// open candidate is resolved elsewhere once its learning is gone or its condition no longer fires.
// In any other mode the counts are recorded and no row is written. A run that could not read the
// store (no head, or a store it could not place) changes nothing.
const shown = (value, most) => cleanEvidenceText(value).replace(/\n/gu, ' ').slice(0, most);
export function settleLearningsCheckInTransaction(store, flow, check, { tasks, config = store.meta('config', {}), nowMs = Date.now() } = {}) {
  // What the store held, for Health (Q2): every refused file with why, in any mode. Bounded text.
  if (check && typeof check === 'object') putLearningsStoreStatusInTransaction(store, { flowId: flow.id, at: new Date(nowMs).toISOString(), head: OBJECT_ID.test(check.head ?? '') ? check.head : null, dir: typeof check.dir === 'string' ? shown(check.dir, 300) : null,
    learnings: Array.isArray(check.entries) ? Math.min(check.entries.length, 40) : 0, ...(check.skipped || check.problem ? { problem: shown(check.skipped ?? check.problem, 300) } : {}),
    refused: (Array.isArray(check.refused) ? check.refused : []).slice(0, 40).map(row => ({ path: shown(row?.path, 300), reason: shown(row?.reason, 300), ...(OBJECT_ID.test(row?.blob ?? '') ? { blob: row.blob } : {}) })), complete: check.complete !== false });
  if (!check || typeof check !== 'object' || check.skipped || check.problem || !Array.isArray(check.entries)) { store.event('learnings.checked', { flowId: flow.id, skipped: String(check?.skipped ?? check?.problem ?? 'no result').slice(0, 300) }); return null; }
  const entries = check.entries.slice(0, 40).filter(row => row && LEARNING.test(row.id ?? '') && typeof row.path === 'string' && OBJECT_ID.test(row.blob ?? '') && Array.isArray(row.fired));
  const fired = new Map(entries.map(row => [row.id, new Set(row.fired.filter(condition => typeof condition === 'string'))]));
  // unused: selected in at least ten flows and never cited (learningUse, by key).
  for (const row of entries) { const use = learningUse(store, row.id); if (use.selected >= UNUSED_SELECTIONS && use.cited === 0) fired.get(row.id).add('unused'); }
  const candidates = entries.flatMap(row => [...fired.get(row.id)].map(condition => ({ kind: 'learning-stale', learningId: row.id, condition, file: row.path, blob: row.blob })));
  const summary = { flowId: flow.id, head: check.head ?? null, learnings: entries.length, fired: candidates.length, refused: Array.isArray(check.refused) ? check.refused.length : 0 };
  if (upkeepMode(config) !== 'propose') { store.event('learnings.checked', { ...summary, recorded: false }); return { ...summary, recorded: false }; }
  const outcomes = {};
  for (let at = 0; at < candidates.length; at += 64) for (const row of raiseCandidatesInTransaction(store, { flowId: flow.id, candidates: candidates.slice(at, at + 64), nowMs, config })) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  // An existing candidate whose learning now reads differently is refreshed, and one the factory had
  // resolved is raised again (review of 004f4ab, P2-1); what was read is kept for a reopen.
  for (const candidate of candidates) { const seen = observeStaleLearningInTransaction(store, { id: staleLearningClassKey(candidate), file: candidate.file, blob: candidate.blob, flowId: flow.id, nowMs }); if (seen && seen !== 'same' && seen !== 'kept') outcomes[seen] = (outcomes[seen] ?? 0) + 1; }
  // An open candidate whose learning is gone, or whose condition no longer fires; and a tasked one
  // whose task has not started (Q5): resolving it closes that task. A task whose flow has started is
  // left to its flow: before its first model step the pin check refuses a file that changed or went,
  // and a condition that no longer fires (operations/upkeep-tasks.mjs followUpPinCheck).
  let resolved = 0;
  if (check.complete !== false) {
    let open = []; try { open = openUpkeepCandidates(store); } catch (error) { if (!(error instanceof UpkeepAccessUnavailable)) throw error; }
    const tasked = ids => (ids ?? []).map(id => store.get('finding', id)).filter(row => row?.status === 'tasked');
    // The one open learning-retire task, by key (upkeepOpen.captureTasks), when no flow has started it.
    const retireId = store.meta(UPKEEP_META.open, {}).captureTasks?.['learning-retire'] ?? null, retire = retireId ? store.get('task', retireId) : null;
    const linked = retire && !retire.closed && retire.status !== 'completed' && tasks && !tasks.started(retire) ? tasked(retire.findings) : [];
    for (const row of [...open.filter(row => row.status === 'unapproved'), ...linked].filter(row => isUpkeepCandidate(row) && row.kind === 'learning-stale')) {
      const conditions = fired.get(row.learningId), reason = !conditions ? 'learning-gone' : !conditions.has(row.condition) ? 'condition-cleared' : null;
      if (!reason) continue;
      resolveFindingElsewhereInTransaction(store, { id: row.id, reason, evidence: reason === 'learning-gone' ? `learnings.check ${flow.id}: ${row.learningId} is no longer in the learnings store at ${String(check.head).slice(0, 12)}` : `learnings.check ${flow.id}: condition ${row.condition} no longer fires for ${row.learningId} at ${String(check.head).slice(0, 12)}`, tasks, nowMs });
      resolved++;
    }
  }
  store.event('learnings.checked', { ...summary, recorded: true, outcomes, resolved, at: now() });
  return { ...summary, recorded: true, outcomes, resolved };
}
