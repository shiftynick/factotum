// Knowledge upkeep: the life of a candidate (knowledge-upkeep design, 4.3 and 4.4).
//
// A raised candidate is a `finding` row keyed by its class key, with `source: 'upkeep'`. Audit
// findings are rows of the same kind and go through the same states, by the same commands (Q13).
//
//   (none)       -> unapproved           the factory raises it
//   unapproved   -> tasked               a task exists for it and is linked (a docs candidate: the
//                                        factory's follow-up, operations/upkeep-tasks.mjs)
//   tasked       -> delivered | failed   the linked flow merged, or failed
//   failed       -> delivered            an audit finding only: a later flow of the same task, at the
//                                        revision the finding was recorded against, merged
//   tasked       -> unapproved           the linked flow was abandoned through no fault of the
//                                        candidate: a return. A third return expires it instead
//   unapproved, tasked -> declined       a person, with a reason
//   unapproved, tasked -> expired        the factory: an age or count limit, or returns exhausted
//   unapproved, tasked -> resolved-elsewhere   the factory, or a person with evidence
//   declined, expired, failed, resolved-elsewhere -> unapproved   a person reopens it
//
// Who may make each move is in FINDING_TRANSITIONS and findingAuthority below; core/project.mjs
// applies them to the three commands (finding.accept, finding.resolve, finding.reopen). The factory
// never reopens a closed candidate: a later observation only adds to its source flows.
//
// A row has a `version`, raised on every change of status and never by a repeat observation. Every
// person's command names the version it read and is refused if the row changed; every function
// here re-reads the row in the caller's transaction before it writes.
//
// Nothing here writes a task or a file, or calls a model. Where a move closes a task, the caller
// (core/project.mjs) passes the function that does it. Reads are by key, except the two the design
// names (4.5): the open candidates (their own partial index, not open audit findings), and observed classes by first-observed time, oldest first.
import { assert, id as recordId } from '../core/contracts.mjs';
import { upkeepSettings } from '../core/upkeep-config.mjs';
import { safeDocsPath } from '../core/upkeep-namespace.mjs';
import { classKey as classKeyOf, collapseWhitespace } from './upkeep-class-key.mjs';
import { recordUpkeepDisposalInTransaction, recordUpkeepMergeInTransaction } from './upkeep-ceilings.mjs';
import { UPKEEP_CANDIDATE_KINDS, UPKEEP_FINDING_SOURCE, UpkeepAccessUnavailable, addToUpkeepOpenInTransaction, deleteObservedClassInTransaction, observedBefore, observedClass, openUpkeepCandidates, putObservedClassInTransaction, upkeepObservedCount, upkeepOpen } from './upkeep-records.mjs';

const DAY = 86400000, iso = ms => new Date(ms).toISOString();
export const FINDING_STATUSES = Object.freeze(['unapproved', 'tasked', 'delivered', 'failed', 'declined', 'expired', 'resolved-elsewhere']);
// The closed states a person may reopen. A delivered finding is not one: its change merged.
export const FINDING_REOPENABLE = Object.freeze(['declined', 'expired', 'failed', 'resolved-elsewhere']);
export const DECLINE_REASONS = Object.freeze(['unnecessary', 'wrong', 'duplicate', 'later']);
export const EXPIRY_REASONS = Object.freeze(['age', 'cap', 'task-not-approved', 'returns-exhausted']);
// Why a linked flow was abandoned through no fault of the candidate.
export const RETURN_REASONS = Object.freeze(['drain', 'base-moved', 'stale']);
// A candidate may return twice; a third abandonment expires it.
export const MAX_RETURNS = 2, MAX_SOURCE_FLOWS = 20, MAX_OBSERVED_CLASSES = 200, MAX_TASK_FINDINGS = 20;
// 8.3: how long a candidate may wait open, by kind; how long an observed class is kept.
export const OPEN_AGE_MS = Object.freeze({ docs: 14 * DAY, context: 30 * DAY, check: 30 * DAY, rule: 30 * DAY, learning: 30 * DAY, 'learning-stale': 30 * DAY });
export const OBSERVED_AGE_MS = 90 * DAY;
// A rule or a learning is recorded as observed from its first flow and raised from its second (Q6).
export const OBSERVED_FIRST = Object.freeze(['rule', 'learning']);
// The part a kind is capped, counted and suspended with. A rule is a capture candidate: it is
// produced only when capture is assessed. A stale learning is bounded by the learnings store.
export const CANDIDATE_PART = Object.freeze({ docs: 'docs', context: 'context', check: 'capture', rule: 'capture', learning: 'capture', 'learning-stale': null });
const kindsOfPart = part => UPKEEP_CANDIDATE_KINDS.filter(kind => CANDIDATE_PART[kind] === part);

export const isUpkeepCandidate = row => row?.source === UPKEEP_FINDING_SOURCE;
// `audit` for every row the audit job wrote; an upkeep row's own kind, or `unknown`.
export const findingKind = row => !isUpkeepCandidate(row) ? 'audit' : UPKEEP_CANDIDATE_KINDS.includes(row.kind) ? row.kind : 'unknown';
export const findingVersion = row => Number.isSafeInteger(row?.version) && row.version > 0 ? row.version : 1;

// ---- Who may do what (4.3) ----
// [from, to, who may make the move]. `factory` is the factory's own code; `person` is a command.
export const FINDING_TRANSITIONS = Object.freeze([
  [null, 'unapproved', ['factory']],
  ['unapproved', 'tasked', ['factory', 'person']], // which of the two depends on the kind: taskedBy
  ['unapproved', 'declined', ['person']], ['tasked', 'declined', ['person']],
  ['unapproved', 'expired', ['factory']], ['tasked', 'expired', ['factory']],
  ['unapproved', 'resolved-elsewhere', ['factory', 'person']], ['tasked', 'resolved-elsewhere', ['factory', 'person']],
  ['tasked', 'delivered', ['factory']], ['tasked', 'failed', ['factory']], ['tasked', 'unapproved', ['factory']],
  ...FINDING_REOPENABLE.map(from => [from, 'unapproved', ['person']]),
  // An audit finding's task is an ordinary task: after a failed flow it may be restarted, and a
  // proven merge of it at the same revision delivers the finding (see settleFindingTaskInTransaction).
  ['failed', 'delivered', ['factory']],
].map(row => Object.freeze(row)));
// How a task comes to exist for a kind: the factory creates a docs follow-up by itself; every
// other kind, and an audit finding, is tasked by a person's finding.accept.
export const taskedBy = kind => kind === 'docs' ? 'factory' : 'person';
export function transitionAllowed(row, to, by) {
  // A stale learning the factory resolved (its learning gone, or its condition cleared) is raised
  // again by the factory when a later check finds the condition firing (review of 004f4ab, P2-1): a
  // new breakage is actionable. Every other closed candidate is reopened only by a person.
  if (row?.status === 'resolved-elsewhere' && to === 'unapproved' && by === 'factory') return findingKind(row) === 'learning-stale' && row.disposition?.by === 'factory';
  const from = row ? row.status : null, rule = FINDING_TRANSITIONS.find(([a, b]) => a === from && b === to);
  if (!rule || !rule[2].includes(by)) return false;
  if (from === 'failed' && to === 'delivered') return findingKind(row) === 'audit';
  return from === 'unapproved' && to === 'tasked' ? taskedBy(findingKind(row)) === by : true;
}
// Which people may act on a finding. A governing-context proposal and a rule are the operator's
// alone (Q2); every other kind, and an audit finding, may also be acted on by the orchestrator on a
// recorded instruction where the command is delegated. A kind this release does not know is the
// operator's.
// A must-fix review row (operations/review-rows.mjs) that is an operator item is the operator's alone.
export const findingAuthority = row => row?.source === 'review' && row.reviewKind !== 'follow-up' ? 'operator' : ['audit', 'docs', 'check', 'learning', 'learning-stale'].includes(findingKind(row)) ? 'delegable' : 'operator';

// ---- Writing a row ----
function move(store, row, to, by, fields, nowMs) {
  assert(transitionAllowed(row, to, by), `a finding cannot go from ${row.status} to ${to} by ${by === 'factory' ? 'the factory' : 'a person\'s command'}`);
  const next = { ...row, ...fields, status: to, version: findingVersion(row) + 1, statusAt: iso(nowMs), ...(to === 'unapproved' ? { openedAt: iso(nowMs) } : {}) };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  store.put('finding', next);
  // The open counts follow the rows: a candidate is open exactly while it is unapproved.
  if (isUpkeepCandidate(row) && UPKEEP_CANDIDATE_KINDS.includes(row.kind) && (row.status === 'unapproved') !== (to === 'unapproved')) addToUpkeepOpenInTransaction(store, { candidates: { [row.kind]: to === 'unapproved' ? 1 : -1 } });
  return next;
}
const need = (store, findingId) => { const row = store.get('finding', findingId); assert(row, `unknown finding: ${findingId}`); return row; };
const part = row => isUpkeepCandidate(row) ? CANDIDATE_PART[row.kind] ?? null : null;
// A context or capture candidate that left the open set, for that part's window (8.3).
function disposed(store, row, outcome, nowMs) { if (['context', 'capture'].includes(part(row))) recordUpkeepDisposalInTransaction(store, { part: part(row), outcome, id: row.id, kind: row.kind, nowMs }); }
// One entry per ended docs follow-up, whatever number of candidates it carried.
function docsEnded(store, rows, taskId, outcome, nowMs) { if (rows.some(row => part(row) === 'docs')) recordUpkeepDisposalInTransaction(store, { part: 'docs', outcome, taskId, nowMs }); }

// ---- Audit obligations (4.4) ----
// An audit finding has a pending obligation, which blocks retention while it is open; the
// finding's disposition closes it. An upkeep candidate has no obligation in any state. An
// obligation a person already resolved is left as they resolved it; one this lifecycle failed is
// passed when a later merge of the same task delivers the finding (`afterFailure`).
const obligationIdOf = row => typeof row.obligationId === 'string' && row.obligationId.startsWith(`finding:${row.id}:`) ? row.obligationId : `finding:${row.id}`;
function closeObligation(store, row, status, evidence, nowMs, extra = {}, { afterFailure = false } = {}) {
  if (isUpkeepCandidate(row)) return;
  const obligation = store.get('obligation', obligationIdOf(row)); if (!obligation) return;
  const failedHere = afterFailure && obligation.status === 'failed' && obligation.resolvedBy === 'finding';
  if (['passed', 'failed', 'deferred'].includes(obligation.status) && !failedHere) return;
  const updated = { ...obligation, status, evidence, resolvedAt: iso(nowMs), resolvedBy: 'finding', ...extra }; store.put('obligation', updated); store.event('obligation.resolved', updated);
}
function reopenObligation(store, row, nowMs) {
  if (isUpkeepCandidate(row)) return null;
  const obligationId = `finding:${row.id}:${row.version}`;
  store.put('obligation', { id: obligationId, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', approved: false, owner: 'operator', reopened: true, createdAt: iso(nowMs) });
  return obligationId;
}

// ---- Raising (the factory) ----
const clip = (value, most) => typeof value === 'string' ? value.slice(0, most) : undefined;
const strings = (value, most, length) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, most).map(item => item.slice(0, length)) : [];
// What a row keeps of a validated candidate (operations/upkeep-assessment.mjs), by kind. Text is
// bounded here as well; the validator has already refused what the text rules refuse.
function content(candidate) {
  const common = { reason: clip(candidate.reason, 2000), signals: strings(candidate.signals, 40, 200), flags: strings(candidate.flags, 16, 64) };
  // A proposal also keeps the configured context entries that reach its file (slice 6), and, when it
  // was a docs candidate whose file became governing, that candidate's id.
  const proposal = candidate.kind === 'context' ? { ...(typeof candidate.replacement === 'string' && candidate.replacement ? { replacement: clip(candidate.replacement, 600) } : {}), entries: strings(candidate.entries, 8, 128), ...(typeof candidate.reclassifiedFrom === 'string' ? { reclassifiedFrom: clip(candidate.reclassifiedFrom, 200) } : {}) } : {};
  if (['docs', 'context'].includes(candidate.kind)) return { file: candidate.file, quote: collapseWhitespace(candidate.quote).slice(0, 4000), ...proposal, ...(/^[a-f\d]{40,64}$/i.test(candidate.blob ?? '') ? { blob: candidate.blob } : {}), ...common, title: `${candidate.file}: ${collapseWhitespace(candidate.quote).slice(0, 120)}` };
  // A stale learning (slice 8) keeps the file and blob learnings.check read; the factory's own words.
  if (candidate.kind === 'learning-stale') return { learningId: candidate.learningId, condition: candidate.condition, ...(safeDocsPath(candidate.file) ? { file: candidate.file } : {}), ...(/^[a-f\d]{40,64}$/i.test(candidate.blob ?? '') ? { blob: candidate.blob } : {}), title: `${candidate.learningId}: ${candidate.condition}` };
  // A rule (slice 7) also keeps the governing file its context anchor reaches at the merge commit,
  // with that file's blob and the configured entries that reach it: what its acceptance into a
  // context task needs, as for a proposal.
  const rule = candidate.kind === 'rule' && safeDocsPath(candidate.file) ? { file: candidate.file, ...(/^[a-f\d]{40,64}$/i.test(candidate.blob ?? '') ? { blob: candidate.blob } : {}), entries: strings(candidate.entries, 8, 128) } : {};
  return { anchor: candidate.anchor, topic: candidate.topic, title: clip(candidate.title, 200), text: clip(candidate.text, 1500), ...rule, ...common };
}
const keyOf = candidate => classKeyOf(['docs', 'context'].includes(candidate.kind) ? { kind: candidate.kind, path: candidate.file, quote: candidate.quote } : candidate);
function expire(store, findingId, reason, nowMs) {
  const row = need(store, findingId), next = move(store, row, 'expired', 'factory', { disposition: { status: 'expired', reason, at: iso(nowMs) } }, nowMs);
  disposed(store, row, 'expired', nowMs); store.event('finding.expired', { id: row.id, kind: findingKind(row), reason }); return next;
}
// Record what one source flow produced. For each candidate: its class key is read by key in
// `finding` and, for a rule or a learning, in `upkeepObserved`.
//   raised          a new open candidate (a rule or a learning: its second distinct flow)
//   observed        a rule or a learning seen in its first flow: not a candidate yet
//   observed-again  the class exists; the flow was added to its source flows, whatever its state
//   same-flow       the same flow again (a manual re-run): nothing is written
//   backlog-full    a docs candidate beyond docs.maxWaiting: not recorded (7.2)
//   cap             the part's cap is zero: not recorded
//   unsafe-path     a docs edit or proposal whose file name fails the filename policy: not recorded
// A context or capture candidate at its part's cap pushes out the oldest open one of that part,
// which expires (the one place this reads the open candidates); an observed class at its cap
// pushes out the oldest observed class.
export function raiseCandidatesInTransaction(store, { flowId, candidates, nowMs = Date.now(), config = store.meta('config', {}) }) {
  recordId(flowId, 'source flow id'); assert(Array.isArray(candidates) && candidates.length <= 64, 'a bounded list of validated candidates');
  const settings = upkeepSettings(config), at = iso(nowMs), results = []; let live = null;
  for (const candidate of candidates) {
    const kind = candidate?.kind; assert(UPKEEP_CANDIDATE_KINDS.includes(kind), `unknown candidate kind ${JSON.stringify(kind ?? null)}`);
    // A docs edit or a proposal names a file within the filename policy, or it is not recorded (P2-1).
    if (['docs', 'context'].includes(kind) && !safeDocsPath(candidate.file)) { results.push({ id: null, kind, outcome: 'unsafe-path' }); continue; }
    const key = keyOf(candidate), done = (outcome, extra = {}) => { results.push({ id: key, kind, outcome, ...extra }); };
    assert(candidate.classKey === undefined || candidate.classKey === key, 'a candidate\'s class key is the factory\'s own digest of its fields');
    const existing = store.get('finding', key);
    if (existing) {
      // A row of another source under this key is never touched.
      if (!isUpkeepCandidate(existing)) { done('collision'); continue; }
      const flows = Array.isArray(existing.sourceFlows) ? existing.sourceFlows : [];
      if (flows.includes(flowId)) { done('same-flow', { status: existing.status }); continue; }
      // A later observation only adds to the source flows: no new version, and no closed candidate reopened.
      store.put('finding', { ...existing, sourceFlows: [...flows, flowId].slice(-MAX_SOURCE_FLOWS), sourceFlowCount: (existing.sourceFlowCount ?? flows.length) + 1, lastObservedAt: at });
      store.event('finding.observed', { id: key, flowId, status: existing.status }); done('observed-again', { status: existing.status }); continue;
    }
    const seen = OBSERVED_FIRST.includes(kind) ? observedClass(store, key) : null;
    if (OBSERVED_FIRST.includes(kind) && !seen) {
      // The oldest observed class makes room, through the index over first-observed time.
      if (upkeepObservedCount(store) >= MAX_OBSERVED_CLASSES) for (const oldest of observedBefore(store, iso(nowMs + 1), 1)) { deleteObservedClassInTransaction(store, oldest.id); addToUpkeepOpenInTransaction(store, { observed: -1 }); }
      putObservedClassInTransaction(store, { id: key, kind, anchor: candidate.anchor, topic: candidate.topic, sourceFlow: flowId, firstObservedAt: at });
      addToUpkeepOpenInTransaction(store, { observed: 1 }); store.event('upkeep.class-observed', { id: key, kind, flowId }); done('observed'); continue;
    }
    if (seen?.sourceFlow === flowId) { done('same-flow', { status: 'observed' }); continue; }
    // The caps (8.3), checked on the maintained counts before anything is written. A part at its
    // cap reads the open candidates (once per call, and only then): first, candidates past their
    // age expire, as wherever the set is read (4.5), so that a stale candidate never holds a place;
    // then, if the part is still full, a docs candidate is not recorded and a context or capture
    // candidate pushes out the oldest open one of its part.
    const of = CANDIDATE_PART[kind], cap = of === 'docs' ? settings.docs.maxWaiting : of ? settings[of].maxOpen : Infinity;
    const count = () => { const open = upkeepOpen(store).candidates; return kindsOfPart(of).reduce((sum, name) => sum + open[name], 0); };
    if (of && cap === 0) { done(of === 'docs' ? 'backlog-full' : 'cap'); continue; }
    // `live` is the open upkeep candidates by id, kept up to date through the rest of this call.
    if (of && count() >= cap && !live) live = new Map(expireOpenCandidatesInTransaction(store, { nowMs, rows: openUpkeepCandidates(store) }).open.filter(row => isUpkeepCandidate(row) && row.status === 'unapproved').map(row => [row.id, row]));
    if (of === 'docs' && count() >= cap) { done('backlog-full'); continue; }
    if (['context', 'capture'].includes(of) && count() >= cap) {
      const oldest = [...live.values()].filter(row => CANDIDATE_PART[row.kind] === of).sort((a, b) => String(a.openedAt ?? a.createdAt).localeCompare(String(b.openedAt ?? b.createdAt)));
      for (const row of oldest.slice(0, count() - cap + 1)) { expire(store, row.id, 'cap', nowMs); live.delete(row.id); }
    }
    const flows = seen ? [seen.sourceFlow, flowId] : [flowId];
    // The second distinct flow: the observed row goes in the transaction that writes the candidate.
    if (seen) { deleteObservedClassInTransaction(store, key); addToUpkeepOpenInTransaction(store, { observed: -1 }); }
    const row = store.put('finding', { id: key, source: UPKEEP_FINDING_SOURCE, kind, status: 'unapproved', approved: false, version: 1, ...content(candidate), provenance: kind === 'learning-stale' ? 'factory' : 'assessment-model', sourceFlows: flows, sourceFlowCount: flows.length, returns: 0, createdAt: at, openedAt: at, lastObservedAt: at, statusAt: at });
    live?.set(key, row);
    addToUpkeepOpenInTransaction(store, { candidates: { [kind]: 1 } }); store.event('finding.raised', { id: key, kind, flowId, sourceFlows: flows.length }); done('raised');
  }
  return results;
}
// What one run's validator kept (operations/upkeep-assessment.mjs validateAssessment), recorded.
// Called by a proposing run's settlement (operations/upkeep-runs.mjs), with the docs part only in
// this release; an observing run counts what the validator kept and writes no row.
export function recordRunCandidatesInTransaction(store, { flowId, accepted, nowMs = Date.now(), config = store.meta('config', {}) }) {
  const results = raiseCandidatesInTransaction(store, { flowId, candidates: ['docs', 'context', 'capture'].flatMap(name => accepted?.[name] ?? []), nowMs, config }), counts = {};
  for (const row of results) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return { results, counts };
}

// ---- A stale learning read again (slice 8, review of 004f4ab, P2-1) ----
// What a later learnings.check read for an existing stale-learning candidate whose condition fires:
//   refreshed     open, and the file or its blob differs: the row takes the current file and blob at a
//                 new version, so a person's command naming the old version is refused and they read
//                 it again before accepting (acceptance pins exactly the blob the row names)
//   raised-again  resolved elsewhere by the factory (its learning was gone, or its condition had
//                 cleared): open again, at a new version, with the current file and blob
//   same, kept    nothing else changes; what was read is kept (`lastRead`), so a person's reopen of a
//                 closed candidate takes the current blob
export function observeStaleLearningInTransaction(store, { id, file, blob, flowId, nowMs = Date.now() }) {
  const row = store.get('finding', id); if (!isUpkeepCandidate(row) || row.kind !== 'learning-stale') return null;
  const at = iso(nowMs), read = { file, blob, at, flowId }, differs = row.blob !== blob || row.file !== file;
  if (row.status === 'unapproved' && differs) {
    const next = { ...row, file, blob, lastRead: read, version: findingVersion(row) + 1, refreshed: { from: row.blob ?? null, at, flowId } };
    store.put('finding', next); store.event('finding.refreshed', { id, kind: 'learning-stale', flowId, from: row.blob ?? null, to: blob }); return 'refreshed';
  }
  if (row.status === 'resolved-elsewhere' && transitionAllowed(row, 'unapproved', 'factory')) {
    move(store, row, 'unapproved', 'factory', { ...unlinked, ...(row.taskId ? { lastTaskId: row.taskId } : {}), file, blob, lastRead: read, returns: 0, returned: undefined, previousDisposition: row.disposition, disposition: undefined, raisedAgain: { at, flowId } }, nowMs);
    store.event('finding.raised-again', { id, kind: 'learning-stale', flowId, previous: row.disposition?.reason ?? null }); return 'raised-again';
  }
  if (row.lastRead?.blob !== blob || row.lastRead?.file !== file) store.put('finding', { ...row, lastRead: read });
  return row.status === 'unapproved' ? 'same' : 'kept';
}

// ---- Expiry (the factory) ----
// Open candidates past their age. Evaluated where the open candidates are read anyway: `rows` is
// that set. Returns the rows still open, and the ones it expired.
export function expireOpenCandidatesInTransaction(store, { nowMs = Date.now(), rows = openUpkeepCandidates(store) } = {}) {
  const open = [], expired = [];
  for (const row of rows) {
    const age = isUpkeepCandidate(row) && row.status === 'unapproved' ? OPEN_AGE_MS[row.kind] : undefined, since = Date.parse(row.openedAt ?? row.createdAt);
    if (age !== undefined && Number.isFinite(since) && nowMs - since >= age) expired.push(expire(store, row.id, 'age', nowMs)); else open.push(row);
  }
  return { open, expired };
}
// Observed classes past their age: an indexed range read of at most 50 rows, oldest first, once per
// run settlement. It never reads the finding set. With the kind unverified nothing is read at all;
// upkeep suspends itself at its next start instead (operations/upkeep-runs.mjs).
export function expireObservedClassesInTransaction(store, { nowMs = Date.now() } = {}) {
  let rows; try { rows = observedBefore(store, iso(nowMs - OBSERVED_AGE_MS)); } catch (error) { if (error instanceof UpkeepAccessUnavailable) return 0; throw error; }
  for (const row of rows) deleteObservedClassInTransaction(store, row.id);
  if (rows.length) { addToUpkeepOpenInTransaction(store, { observed: -rows.length }); store.event('upkeep.observed-expired', { count: rows.length }); }
  return rows.length;
}

// ---- A task for it ----
// unapproved -> tasked, at the expected version of each row. `by` is `factory` (a docs follow-up
// the factory created) or `person` (finding.accept). The caller writes the task, in this
// transaction, with the ids returned here as its `findings`.
export function linkFindingsInTransaction(store, { findings, task, by, actor = 'factory', nowMs = Date.now() }) {
  assert(Array.isArray(findings) && findings.length > 0 && findings.length <= MAX_TASK_FINDINGS && new Set(findings.map(row => row?.id)).size === findings.length, `one to ${MAX_TASK_FINDINGS} distinct findings`);
  assert(typeof task?.id === 'string' && typeof task.revision === 'string', 'a finding is linked to a task that exists, at its revision');
  return findings.map(({ id, expectedVersion }) => {
    const row = need(store, id);
    assert(row.status === 'unapproved', `finding ${id} is ${row.status}, not open; only an open finding gets a task`);
    assert(findingVersion(row) === expectedVersion, `finding ${id} changed since it was read (version ${findingVersion(row)}); read it again`);
    const next = move(store, row, 'tasked', by, { taskId: task.id, taskRevision: task.revision, taskedAt: iso(nowMs), taskedBy: actor }, nowMs);
    disposed(store, row, 'accepted', nowMs); store.event('finding.tasked', { id, kind: findingKind(row), taskId: task.id, by: actor }); return next;
  });
}
// The findings of a task that are still waiting on it. With `taskRevision`, also an audit finding
// whose earlier flow of this task failed, if it was recorded against this same revision.
const linked = (store, taskId, findingIds, { taskRevision = null } = {}) => [...new Set(findingIds ?? [])].map(findingId => store.get('finding', findingId)).filter(row => row?.taskId === taskId && (row.status === 'tasked' || typeof taskRevision === 'string' && row.status === 'failed' && !isUpkeepCandidate(row) && row.taskRevision === taskRevision));
const unlinked = { taskId: undefined, taskRevision: undefined, taskedAt: undefined, taskedBy: undefined };

// What the factory does to the findings of a task when the task's flow ends (or never starts).
//   delivered           the linked flow merged
//   failed              the linked flow failed, or was abandoned for a fault
//   returned            the linked flow was abandoned through no fault of the candidate: back to
//                       unapproved, counted as a return; a third return expires it instead. The task is closed
//   expired             the task was not approved in time. The task is closed
//   resolved-elsewhere  the task ended without a merge because nothing was left to do; `completion`
//                       is what the flow's completion rests on, kept with the disposition
// `closeTask` closes the task (core/project.mjs); it is required where the design closes it.
// `taskRevision` is the revision the flow ran; a delivery also takes a failed audit finding that
// was recorded against that revision of this task (a restarted task that then merged).
export function settleFindingTaskInTransaction(store, { taskId, findingIds, outcome, reason = null, evidence = null, completion = null, flowId = null, taskRevision = null, upkeepTask = false, closeTask = null, nowMs = Date.now() }) {
  assert(['delivered', 'failed', 'returned', 'expired', 'resolved-elsewhere'].includes(outcome), `unknown task outcome ${outcome}`);
  const rows = linked(store, taskId, findingIds, outcome === 'delivered' ? { taskRevision } : {}), at = iso(nowMs), changed = []; if (!rows.length) return changed;
  if (outcome === 'returned') assert(RETURN_REASONS.includes(reason), `a return names why the flow was abandoned: ${RETURN_REASONS.join(', ')}`);
  if (['returned', 'expired'].includes(outcome)) assert(typeof closeTask === 'function', 'a returned or expired task is closed in the same transaction');
  for (const row of rows) {
    if (outcome === 'delivered') { const late = row.status === 'failed'; changed.push(move(store, row, 'delivered', 'factory', { disposition: { status: 'delivered', ...(flowId ? { flowId } : {}), ...(late ? { afterFailure: row.disposition ?? null } : {}), at } }, nowMs)); closeObligation(store, row, 'passed', `Task ${taskId} merged${late ? ` (after an earlier flow of the task failed)` : ''}`, nowMs, { taskId }, { afterFailure: late }); }
    else if (outcome === 'failed') { changed.push(move(store, row, 'failed', 'factory', { disposition: { status: 'failed', reason: reason ?? 'flow-failed', ...(flowId ? { flowId } : {}), at } }, nowMs)); closeObligation(store, row, 'failed', `The flow of task ${taskId} failed`, nowMs, { taskId }); }
    else if (outcome === 'resolved-elsewhere') { changed.push(move(store, row, 'resolved-elsewhere', 'factory', { disposition: { status: 'resolved-elsewhere', evidence: evidence ?? `Task ${taskId} ended with nothing left to do`, ...(completion ? { completion } : {}), at } }, nowMs)); disposed(store, row, 'resolved-elsewhere', nowMs); closeObligation(store, row, 'passed', evidence ?? `Task ${taskId} ended with nothing left to do`, nowMs, { taskId }); }
    else if (outcome === 'expired' || (row.returns ?? 0) >= MAX_RETURNS) {
      const why = outcome === 'expired' ? 'task-not-approved' : 'returns-exhausted';
      changed.push(move(store, row, 'expired', 'factory', { disposition: { status: 'expired', reason: why, at } }, nowMs)); disposed(store, row, 'expired', nowMs);
    }
    else changed.push(move(store, row, 'unapproved', 'factory', { ...unlinked, lastTaskId: taskId, returns: (row.returns ?? 0) + 1, returned: { reason, at } }, nowMs));
    const next = changed.at(-1); store.event(`finding.${next.status === 'unapproved' ? 'returned' : next.status}`, { id: row.id, kind: findingKind(row), taskId, ...(next.disposition?.reason ? { reason: next.disposition.reason } : {}), ...(next.status === 'unapproved' ? { returns: next.returns, reason } : {}) });
  }
  // How the follow-up ended, once per task. A return is not an ending unless it expired a candidate.
  const ending = { delivered: 'merged', failed: reason === 'rejected' ? 'rejected' : 'failed', expired: 'expired', returned: changed.some(row => row.status === 'expired') ? 'expired' : null }[outcome];
  if (ending) docsEnded(store, rows, taskId, ending, nowMs);
  if (outcome === 'delivered' && upkeepTask && flowId) recordUpkeepMergeInTransaction(store, { flowId, taskId, nowMs });
  if (closeTask) closeTask(taskId, outcome === 'returned' ? `its flow was abandoned (${reason}); its candidates returned` : 'its candidates expired');
  return changed;
}

// ---- Dispositions: declined, resolved elsewhere ----
// `tasks` is what core/project.mjs knows about tasks: get(taskId), busy(task) (why its flow keeps
// it from being closed, or null), started(task), close(taskId, why).
//
// Declining a tasked finding acts on its task: the task is closed, and every finding linked to it
// is declined with the same reason. There is no partial decline. Recording that one tasked finding
// was resolved elsewhere closes its task only if the task has not started; the other findings of
// that task then return to unapproved, which is not counted as a return (no flow was abandoned).
function dispose(store, row, who, record, tasks, nowMs) {
  const disposition = record.status, at = iso(nowMs);
  assert(['unapproved', 'tasked'].includes(row.status), `finding ${row.id} is ${row.status}; ${FINDING_REOPENABLE.includes(row.status) ? 'reopen it first (finding.reopen)' : 'its change merged, so there is nothing left to dispose of'}`);
  const apply = (target, extra = {}) => {
    const next = move(store, target, disposition, who, { disposition: { ...record, ...extra } }, nowMs);
    disposed(store, target, disposition, nowMs);
    closeObligation(store, target, disposition === 'declined' ? 'deferred' : 'passed', disposition === 'declined' ? `Declined: ${record.reason}${record.note ? ` (${record.note})` : ''}` : record.evidence, nowMs);
    store.event(`finding.${disposition === 'declined' ? 'declined' : 'resolved'}`, { id: target.id, kind: findingKind(target), ...(disposition === 'declined' ? { reason: record.reason } : {}), by: record.by, ...(extra.with ? { with: extra.with } : {}) }); return next;
  };
  if (row.status === 'unapproved') return { finding: apply(row), linked: [], closedTask: null };
  const task = tasks.get(row.taskId), others = task ? linked(store, task.id, task.findings).filter(other => other.id !== row.id) : [];
  if (disposition === 'declined') {
    // The task goes with it, so it must be free to close: a task with an unfinished flow is stopped first.
    const busy = task ? tasks.busy(task) : null; assert(!busy, `finding ${row.id} has a task (${row.taskId}) that cannot be closed yet: ${busy}`);
    const finding = apply(row), also = others.map(other => apply(other, { with: row.id }));
    docsEnded(store, [row, ...others], row.taskId, 'declined', nowMs);
    if (task) tasks.close(task.id, `finding ${row.id} was declined (${record.reason})`);
    return { finding, linked: also, closedTask: task?.id ?? null };
  }
  const finding = apply(row);
  if (!task || tasks.started(task)) return { finding, linked: [], closedTask: null };
  const back = others.map(other => { const next = move(store, other, 'unapproved', 'factory', { ...unlinked, lastTaskId: task.id, returned: { reason: 'task-closed', at } }, nowMs); store.event('finding.returned', { id: other.id, kind: findingKind(other), taskId: task.id, reason: 'task-closed', returns: next.returns ?? 0 }); return next; });
  tasks.close(task.id, `finding ${row.id} was resolved elsewhere`);
  return { finding, linked: back, closedTask: task.id };
}
// A person's disposition (finding.resolve): declined, with a reason, or resolved elsewhere, with
// evidence; at the expected version.
export function disposeFindingInTransaction(store, { id, expectedVersion, disposition, reason, evidence, note, by, tasks, nowMs = Date.now() }) {
  const row = need(store, id);
  assert(findingVersion(row) === expectedVersion, `finding ${id} changed since it was read (version ${findingVersion(row)}); read it again`);
  assert(['declined', 'resolved-elsewhere'].includes(disposition), 'finding.resolve records declined or resolved-elsewhere; every other state is the factory\'s to record');
  if (disposition === 'declined') assert(DECLINE_REASONS.includes(reason), `declining needs a reason: ${DECLINE_REASONS.join(', ')}`);
  else assert(typeof evidence === 'string' && evidence.trim() && evidence.length <= 4000, 'resolved-elsewhere needs evidence: what dealt with it (at most 4000 characters)');
  return dispose(store, row, 'person', { status: disposition, ...(disposition === 'declined' ? { reason } : { evidence }), ...(typeof note === 'string' && note.trim() ? { note } : {}), by: by.actor, ...(by.onBehalfOf ? { onBehalfOf: by.onBehalfOf } : {}), at: iso(nowMs) }, tasks, nowMs);
}
// The factory's own: the quoted statement is no longer in the file at the target head, the source
// merge was reverted, the learning file is gone or its condition no longer fires. The row is read
// again here; an open or tasked finding only. The factory never declines.
// `reclassified` (slice 6): a docs candidate whose file became governing, recorded again as a
// governing-context proposal (operations/upkeep-tasks.mjs).
export const FACTORY_RESOLUTIONS = Object.freeze(['statement-gone', 'source-reverted', 'learning-gone', 'condition-cleared', 'reclassified']);
export function resolveFindingElsewhereInTransaction(store, { id, reason, evidence = null, tasks, nowMs = Date.now() }) {
  assert(FACTORY_RESOLUTIONS.includes(reason), `the factory resolves a finding elsewhere for one of ${FACTORY_RESOLUTIONS.join(', ')}`);
  return dispose(store, need(store, id), 'factory', { status: 'resolved-elsewhere', reason, evidence: evidence ?? reason, by: 'factory', at: iso(nowMs) }, tasks, nowMs);
}

// ---- Reopening (finding.reopen) ----
// A person only: declined, expired, failed or resolved-elsewhere back to unapproved, at the expected
// version. The return count starts again. An audit finding gets a new pending obligation. A
// candidate is not reopened into a part that is at its cap: nothing is pushed out for a reopen.
export function reopenFindingInTransaction(store, { id, expectedVersion, note, by, nowMs = Date.now(), config = store.meta('config', {}) }) {
  const row = need(store, id);
  assert(findingVersion(row) === expectedVersion, `finding ${id} changed since it was read (version ${findingVersion(row)}); read it again`);
  assert(FINDING_REOPENABLE.includes(row.status), `finding ${id} is ${row.status}; ${row.status === 'unapproved' ? 'it is already open' : row.status === 'tasked' ? 'it has a task: decline it first to close the task' : 'its change merged; new work is a new task'}`);
  const of = part(row);
  if (of) {
    const settings = upkeepSettings(config), open = upkeepOpen(store).candidates, cap = of === 'docs' ? settings.docs.maxWaiting : settings[of].maxOpen, count = kindsOfPart(of).reduce((sum, name) => sum + open[name], 0);
    assert(count < cap, `${count} ${of} candidate${count === 1 ? ' is' : 's are'} open, which is the limit (${cap}); decline one, or wait for one to end, before reopening another`);
  }
  // A stale learning reopened takes what the latest check read (review of 004f4ab, P2-1).
  const latest = findingKind(row) === 'learning-stale' && /^[a-f\d]{40,64}$/i.test(row.lastRead?.blob ?? '') ? { blob: row.lastRead.blob, file: row.lastRead.file } : {};
  const next = move(store, row, 'unapproved', 'person', { ...unlinked, ...(row.taskId ? { lastTaskId: row.taskId } : {}), ...latest, returns: 0, returned: undefined, previousDisposition: row.disposition, disposition: undefined, reopened: { by: by.actor, ...(by.onBehalfOf ? { onBehalfOf: by.onBehalfOf } : {}), note, at: iso(nowMs) } }, nowMs);
  const obligationId = reopenObligation(store, next, nowMs);
  const reopened = obligationId ? store.put('finding', { ...next, obligationId }) : next;
  store.event('finding.reopened', { id, kind: findingKind(row), from: row.status, by: by.actor }); return reopened;
}

// ---- Health ----
// What the Health tab shows of upkeep: the open candidates with when each expires. A read model:
// `rows` is the live finding set as the caller read it. Observed classes are not candidates and
// are not shown.
export function candidateView(row, nowMs = Date.now()) {
  const age = OPEN_AGE_MS[row.kind], since = Date.parse(row.openedAt ?? row.createdAt), expiresAt = age !== undefined && Number.isFinite(since) ? iso(since + age) : null;
  return { id: row.id, kind: findingKind(row), part: part(row), authority: findingAuthority(row), status: row.status, version: findingVersion(row), title: row.title ?? null, file: row.file ?? null, quote: row.quote ?? null, replacement: row.replacement ?? null, text: row.text ?? null, anchor: row.anchor ?? null, topic: row.topic ?? null, reason: row.reason ?? null, flags: row.flags ?? [], provenance: row.provenance ?? null,
    entries: Array.isArray(row.entries) ? row.entries : [], blob: row.blob ?? null, ...(row.reclassifiedFrom ? { reclassifiedFrom: row.reclassifiedFrom } : {}),
    sourceFlows: row.sourceFlows ?? [], sourceFlowCount: row.sourceFlowCount ?? (row.sourceFlows ?? []).length, returns: row.returns ?? 0, openedAt: row.openedAt ?? row.createdAt ?? null,
    // An open candidate expires by age; a tasked or closed one does not (its task has its own limit).
    expiresAt: row.status === 'unapproved' ? expiresAt : null, overdue: row.status === 'unapproved' && expiresAt !== null && Date.parse(expiresAt) <= nowMs,
    taskId: row.taskId ?? null, lastTaskId: row.lastTaskId ?? null, statusAt: row.statusAt ?? null, disposition: row.disposition ?? null };
}
