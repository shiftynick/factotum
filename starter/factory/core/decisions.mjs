// Durable decisions, direct operator first (plans 7/8, slice B).
//
// Commands over the slice A records: decision.open, decision.present,
// decision.dispose, decision.revoke and decision.ratify; task.put carry-forward;
// the bound inbox card (communication v2) and its answer; the hold lookup the
// engine and admission read; and read projections for the service and console.
//
// The operator disposes of a decision directly. Since slice C the orchestrator can
// also dispose of one by citing a stored operator grant entry that pins this exact
// decision version, scope, options and answer (or cancellation payload); operational
// delegation never suffices. Words the operator said elsewhere, entered by the
// orchestrator without such a grant, are kept as a relayed answer for the operator to
// confirm; they never settle a decision on their own. Every
// write goes through putAuthorityRecord in the caller's command transaction, so
// a rejected command leaves nothing behind and a replayed command returns its
// canonical receipt without reapplying anything.
//
// Nothing here is active on a schema-1 database: every command refuses, and
// every lookup returns no holds.
import { assert, digest, id, now, uid } from './contracts.mjs';
import { auditAuthorityRecords, authorityLedgerEnabled, authoritySubjectDigest, bumpTaskAuthority, dispositionPayloadDigest, dispositionSubject, optionSetDigest, putAuthorityRecord, RECORD_SCHEMA_VERSION, scopeDigest, taskRevisionId } from './decision-authority.mjs';
import { grantLapse, consumeGrant, grantUseLapse } from './grants.mjs';
import { publishDecisionCard } from './communication.mjs';
import { assertCurrentQuestion } from './stale-question.mjs';

export const DECISION_BOUNDARIES = Object.freeze(['build', 'merge', 'complete', 'release']);
// The boundary each protected operation reaches, by operation semantics, never by node name.
// An already-satisfied outcome is delivery acceptance without a merge, so it is held like one.
export const OPERATION_BOUNDARY = Object.freeze({ 'provider.build': 'build', 'forge.merge': 'merge', 'outcome.satisfied': 'merge', 'forge.closeTask': 'complete' });
// A canceled decision removed its scope from the revisions it covers: that work cannot be delivered.
const CANCELED_BLOCKS = ['merge', 'complete', 'release'];
const STATUS_OF = { answer: 'resolved', cancel: 'canceled', supersede: 'superseded' };
// Reserved for the non-resolving card choice.
const DISCUSS = 'discuss';
const DIRECT_ONLY = 'needs the operator directly; delegated and orchestrator commands are refused';
const GRANT_OR_RELAY = 'needs the operator directly, or a stored operator grant entry covering this exact decision version and disposition (send authority: {grantId, entryId, expectedVersion}); operational delegation and onBehalfOf do not suffice. To pass on what the operator said, record it with decision.relay (or relay {quote, channel} on the card) for the operator to confirm';
// The most task revisions one decision records (slice A record schema).
const MAX_APPLICABILITY = 64;

const projectOf = store => store.meta('project').projectId;
const requireLedger = (store, operation) => assert(authorityLedgerEnabled(store), `${operation} needs the migrated authority ledger (database schema 2); this project has not been migrated`);
const text = (value, label, max = 4000) => { assert(typeof value === 'string' && value.trim() && value.length <= max, `${label} is required (1-${max} characters)`); return value; };
const optional = (p, key, label, max) => (p[key] === undefined ? {} : { [key]: text(p[key], label, max) });
const only = (p, keys, operation) => { const extra = Object.keys(p).filter(key => !keys.includes(key)); assert(!extra.length, `${operation} does not accept ${extra.join(', ')}; it accepts ${keys.join(', ')}`); };
const direct = ({ actor, onBehalfOf }, operation) => assert(actor === 'operator' && !onBehalfOf, `${operation} ${DIRECT_ONLY}`);
const commandOf = (store, operation) => { const commandId = store.commandId; assert(typeof commandId === 'string', `${operation} runs only as a recorded command`); return commandId; };
const key = a => `${a.taskId}@${a.revision}`;
const revisions = record => record.applicability.map(key);
const sameRevisions = (a, b) => a.length === b.length && a.every(x => b.includes(x));

export const taskDecisions = (store, taskId) => authorityLedgerEnabled(store) ? store.all('decisionObligation').filter(o => o.taskId === taskId) : [];
const settledFor = o => o.applicability.every(a => a.state === 'covered');

// Scope removal. A decision superseded with removedScope removed its scope from
// one revised brief: the removal revision. It also clears later revisions
// recorded from that brief, by their first snapshot's lineage, unless the
// lineage passes back through a revision the decision applied to before the
// removal. A revision the decision applied to before the removal is never
// cleared: revision digests are content-addressed, so restoring an earlier brief
// is that earlier revision again, scope included. Leaving the cleared lineage
// (back to such a revision, or to any revision it does not clear) reopens the
// choice as a fresh unresolved decision bound to the new revision; the
// superseded decision and its disposition stay as they are.
function removalOf(store, o) {
  if (o.status !== 'superseded' || !o.activeDispositionId) return null;
  const d = store.get('decisionDisposition', o.activeDispositionId);
  return d?.kind === 'supersede' && d.supersession.removedScope !== undefined ? d.supersession : null;
}
function clearedByRemoval(store, o, removal, revision) {
  if (revision === removal.revisedRevision) return true;
  const before = new Set(o.applicability.map(a => a.revision));
  if (!revision || before.has(revision)) return false;
  const projectId = projectOf(store), seen = new Set([revision]);
  let snapshot = store.get('taskRevision', taskRevisionId(projectId, o.taskId, revision));
  while (snapshot?.previousRevision && !seen.has(snapshot.previousRevision)) {
    const previous = snapshot.previousRevision;
    if (previous === removal.revisedRevision) return true;
    if (before.has(previous)) return false;
    seen.add(previous); snapshot = store.get('taskRevision', taskRevisionId(projectId, o.taskId, previous));
  }
  return false;
}
// A reopening of o that applies to this revision, whatever its state, owns the choice there.
// A reopening chain owns a revision only if every link is sound: each predecessor
// exists, is superseded, and has the same task and scope, and the chain ends at an
// original decision without cycles. Corrupt evidence owns nothing, so the backstop hold stays.
function reopensChainEnds(store, o) {
  const seen = new Set([o.id]);
  let at = o;
  while (at.reopens !== undefined) {
    if (seen.has(at.reopens)) return false;
    const prior = store.get('decisionObligation', at.reopens);
    if (!prior || prior.taskId !== o.taskId || prior.scopeDigest !== o.scopeDigest || prior.status !== 'superseded') return false;
    seen.add(prior.id); at = prior;
  }
  return true;
}
const reopenedAt = (store, o, revision) => reopensChainEnds(store, o) && taskDecisions(store, o.taskId).some(x => x.reopens === o.id && reopensChainEnds(store, x) && x.applicability.some(a => a.revision === revision));

// The holds a decision places on one task revision: an uncovered applicability
// entry holds its required boundaries; a canceled decision holds delivery of the
// revisions it covers. A superseded decision holds nothing through its
// replacements' revisions, but a scope removal never clears a revision it
// applied to before the removal: until a reopening applies there, it holds it.
function holdOf(store, o, taskId, revision) {
  if (o.status === 'superseded') {
    const removal = removalOf(store, o);
    if (!removal || revision === removal.revisedRevision || !o.applicability.some(a => a.taskId === taskId && a.revision === revision) || reopenedAt(store, o, revision)) return null;
    return { decisionId: o.id, version: o.version, status: o.status, state: 'reintroduced', boundaries: [...o.requiredAt], reason: `superseded by a scope removal at revision ${removal.revisedRevision.slice(0, 12)}, but this revision is one it applied to before the removal, so the removed scope is back; it needs a fresh decision (editing the task to this revision reopens one)` };
  }
  const entry = o.applicability.find(a => a.taskId === taskId && a.revision === revision);
  if (!entry) return null;
  if (entry.state !== 'covered') return { decisionId: o.id, version: o.version, status: o.status, state: entry.state, boundaries: [...o.requiredAt], reason: entry.state === 'pending' ? 'unresolved' : 'answered for an earlier revision; needs confirmation on this one' };
  // A clearance resting on a revoked or expired grant no longer clears anything,
  // even before the lapse is recorded: the boundary reads the grant's current state.
  const lapse = clearanceLapse(store, o);
  if (lapse) return { decisionId: o.id, version: o.version, status: o.status, state: 'grant-lapsed', boundaries: [...new Set([...o.requiredAt, ...(o.status === 'canceled' ? CANCELED_BLOCKS : [])])], reason: `${o.status} under ${lapse}; ratify the answer directly or settle it anew` };
  if (o.status === 'canceled') return { decisionId: o.id, version: o.version, status: o.status, state: entry.state, boundaries: [...CANCELED_BLOCKS], reason: 'canceled: its removed scope cannot be delivered at this revision' };
  return null;
}
// Why the active disposition of a settled decision no longer clears it, or null.
export function clearanceLapse(store, o, at = Date.now()) {
  if (!o.activeDispositionId || o.status === 'superseded') return null;
  const d = store.get('decisionDisposition', o.activeDispositionId);
  const use = d ? store.get('authorityUse', d.authorityUseId) : null;
  return use?.source === 'grant' ? (grantUseLapse(store, use.id, at) ? `grant ${use.grantId} ${grantLapse(store.get('operatorGrant', use.grantId), at) ?? 'authority use inactive'}` : null) : null;
}
export function decisionHolds(store, taskId, revision, boundary) {
  return taskDecisions(store, taskId).map(o => holdOf(store, o, taskId, revision)).filter(hold => hold && (!boundary || hold.boundaries.includes(boundary)));
}
export const holdReason = (hold, boundary) => `decision-held: decision ${hold.decisionId} (version ${hold.version}) is ${hold.reason}${boundary ? `; it blocks ${boundary}` : ''}`;
export function assertNoDecisionHold(store, taskId, revision, boundary, what) {
  const holds = decisionHolds(store, taskId, revision, boundary);
  assert(!holds.length, `${what} refused: ${holds.map(hold => holdReason(hold, boundary)).join('; ')}`);
}
// Any unresolved or uncovered decision of a task, at any revision: attention material.
export const unresolvedTaskDecisions = (store, taskId) => taskDecisions(store, taskId).filter(o => o.status !== 'superseded' && (o.status === 'unresolved' || !settledFor(o)));

// Presentation cards bound to an older decision version, or to a settled
// decision, cannot be answered: retire them so they stop reminding. The decision
// itself is untouched; it can be presented again.
function retireCards(store, o, reason, { keep } = {}) {
  for (const item of store.all('inbox').filter(row => row.purpose === 'decision' && row.status === 'open' && row.decision?.decisionId === o.id && row.id !== keep)) {
    if (item.decision.version === o.version && !settledFor(o)) continue;
    item.status = 'superseded'; item.supersededBy = store.commandActor ?? null; item.supersededReason = reason; item.version++; store.put('inbox', item);
    const wait = store.get('wait', `question:${item.id}`); if (wait && !wait.endedAt) store.put('wait', { ...wait, endedAt: now(), reason: 'decision changed' });
    store.event('inbox.superseded', { inboxId: item.id, decisionId: o.id, reason });
  }
}
function writeDecision(store, previous, changes, reason) {
  const next = { ...previous, ...changes, version: previous.version + 1, updatedAt: now() };
  if (changes.supersededBy === undefined) delete next.supersededBy;
  putAuthorityRecord(store, 'decisionObligation', next, { expectedVersion: previous.version });
  retireCards(store, next, reason);
  supersedeRelays(store, next, reason);
  return next;
}
const pendingEntries = o => o.applicability.map(({ taskId, revision, state }) => ({ taskId, revision, state: state === 'covered' ? 'pending' : state }));

// A hold that appears after a protected effect was dispatched cannot prevent it.
// Record the race on the flow and tell the operator; never stop or undo the effect.
function recordAuthorityRaces(store, o, cause) {
  const races = [];
  for (const flow of store.all('flow').filter(f => f.taskId === o.taskId && f.attemptId && !['completed', 'failed'].includes(f.state))) {
    const attempt = store.get('attempt', flow.attemptId), operation = attempt?.intent?.action?.operation, boundary = OPERATION_BOUNDARY[operation];
    if (!attempt || attempt.settledAt || !['dispatching', 'running', 'uncertain'].includes(attempt.status) || !boundary) continue;
    const hold = holdOf(store, o, flow.taskId, flow.taskRevision);
    if (!hold?.boundaries.includes(boundary)) continue;
    const race = { decisionId: o.id, decisionVersion: o.version, cause, attemptId: attempt.id, operation, boundary, at: now() };
    store.put('flow', { ...flow, authorityRaces: [...(flow.authorityRaces ?? []), race] });
    const noticeId = `authority-race:${attempt.id}:${o.id}:${o.version}`;
    if (!store.get('inbox', noticeId)) store.put('inbox', { id: noticeId, kind: 'notice', status: 'open', version: 1, role: 'operator', flowId: flow.id, taskId: flow.taskId, decisionId: o.id, title: `Decision hold arrived after ${operation} was dispatched`, context: `${cause} reopened decision ${o.id} while attempt ${attempt.id} (${operation}) was already dispatched. The effect may complete and will be recorded as fact; it was not prevented. The decision stays unresolved and still holds ${o.requiredAt.join(', ')}.`, createdAt: now() });
    store.event('decision.authority-race', { ...race, flowId: flow.id, taskId: flow.taskId });
    races.push({ ...race, flowId: flow.id });
  }
  return races;
}

// Under notifications.level "actionable", a completed flow's summary already
// suppressed as routine is attention material again once its task has an
// unresolved decision: requeue it so delivery reclassifies on the canonical lookup.
function requeueRoutineSummaries(store, taskId) {
  const flows = new Set(store.all('flow').filter(f => f.taskId === taskId).map(f => f.id));
  for (const row of store.all('delivery').filter(d => d.status === 'suppressed' && d.event === 'inbox.attention')) {
    const item = store.get('inbox', row.inboxId);
    if (!item || item.status !== 'open' || item.version !== row.inboxVersion || !flows.has(item.flowId) || !item.id.startsWith(`flow-notice:${item.flowId}:completed:`)) continue;
    store.put('delivery', { ...row, status: 'pending', nextAt: now() });
    store.event('notification.reclassified', { deliveryId: row.id, inboxId: item.id, taskId, reason: 'unresolved decision' });
  }
}

function needTaskRevision(store, task, operation) {
  assert(!['schedule', 'job'].includes(task.approvalKind) && !task.id.startsWith('job:'), `${operation}: maintenance runs carry no product decisions`);
  assert(store.get('taskRevision', taskRevisionId(projectOf(store), task.id, task.revision)) && store.get('taskAuthority', task.id), `${operation}: task ${task.id} revision ${task.revision} has no recorded snapshot`);
}

// decision.open: an operator-owned decision on one task's current revision. The
// operator or the orchestrator may open one; opening only adds a hold.
export function openDecision(store, p, { actor }) {
  requireLedger(store, 'decision.open');
  only(p, ['decisionId', 'taskId', 'expectedRevision', 'question', 'rationale', 'choiceId', 'featureId', 'paths', 'options', 'requiredAt', 'source'], 'decision.open');
  const task = store.need('task', id(p.taskId, 'task id'));
  assert(p.expectedRevision === task.revision, 'task revision changed; read the task again before opening a decision on it');
  needTaskRevision(store, task, 'decision.open');
  const decisionId = p.decisionId === undefined ? uid() : id(p.decisionId, 'decision id');
  assert(!store.get('decisionObligation', decisionId), `decision ${decisionId} already exists`);
  assert(Array.isArray(p.options) && p.options.length >= 1 && p.options.length <= 16, 'a decision needs one to sixteen options: [{id, label}]');
  const options = p.options.map(option => {
    assert(option && typeof option === 'object' && Object.keys(option).every(k => ['id', 'label'].includes(k)), 'an option is {id, label}');
    id(option.id, 'option id'); assert(option.id !== DISCUSS, `option id ${DISCUSS} is reserved for the non-resolving card choice`);
    text(option.label, 'option label', 500);
    return { id: option.id, label: option.label, payloadDigest: digest({ optionId: option.id, label: option.label }) };
  });
  // A producer may add boundaries, never remove merge and complete.
  const asked = p.requiredAt ?? [];
  assert(Array.isArray(asked) && asked.every(b => DECISION_BOUNDARIES.includes(b)), `requiredAt is a list of ${DECISION_BOUNDARIES.join(', ')}`);
  const requiredAt = DECISION_BOUNDARIES.filter(b => ['merge', 'complete'].includes(b) || asked.includes(b));
  const scope = { taskId: task.id, choiceId: id(p.choiceId, 'choice id'), ...(p.featureId !== undefined ? { featureId: id(p.featureId, 'feature id') } : {}), ...(p.paths !== undefined ? { paths: p.paths } : {}) };
  if (p.source !== undefined) assert(p.source && typeof p.source === 'object' && Object.keys(p.source).every(k => ['ref', 'flowId'].includes(k)), 'source is {ref?, flowId?}');
  const source = { kind: actor === 'operator' ? 'operator' : 'orchestrator', ...(p.source?.ref !== undefined ? { ref: text(p.source.ref, 'source ref', 500) } : {}), ...(p.source?.flowId !== undefined ? { flowId: id(p.source.flowId, 'source flow id') } : {}) };
  const at = now();
  const decision = { schemaVersion: RECORD_SCHEMA_VERSION, id: decisionId, projectId: projectOf(store), taskId: task.id, originRevision: task.revision, version: 1, owner: 'operator', source, question: text(p.question, 'question'), ...optional(p, 'rationale', 'rationale'), scope, scopeDigest: scopeDigest(scope), options, optionSetDigest: optionSetDigest(options), requiredAt, applicability: [{ taskId: task.id, revision: task.revision, state: 'pending' }], status: 'unresolved', activeDispositionId: null, createdAt: at, updatedAt: at };
  putAuthorityRecord(store, 'decisionObligation', decision);
  const authorityRevision = bumpTaskAuthority(store, task.id, 'decision-open', decisionId);
  assertTaskRecordsSound(store, task.id, 'decision.open');
  const races = recordAuthorityRaces(store, decision, 'decision.open');
  requeueRoutineSummaries(store, task.id);
  store.event('decision.opened', { decisionId, taskId: task.id, revision: task.revision, requiredAt, actor, authorityRevision });
  return { ...decision, authorityRevision, ...(races.length ? { authorityRaces: races } : {}) };
}

// The in-transaction safeguard: a decision command (and a task edit that moved
// decisions) is refused, and rolled back with everything it wrote, if the task's
// decision-authority records would then fail the audit. Scoped to one task, so
// its cost follows that task's records, not the project's.
function assertTaskRecordsSound(store, taskId, operation) {
  const problems = auditAuthorityRecords(store, { taskId, limit: 5 });
  assert(!problems.length, `${operation} refused: it would leave decision-authority records of task ${taskId} that fail the audit: ${problems.map(x => `${x.kind} ${x.id}: ${x.reason}`).join('; ')}`);
}

// A fresh, unresolved decision restating a superseded decision's choice on the
// revision that brought its removed scope back. The superseded decision and its
// disposition are untouched; the reopening needs new direct authority.
function reopenDecision(store, o, removal, task) {
  const projectId = projectOf(store), at = now();
  const decisionId = digest({ kind: 'decisionReopening', projectId, decisionId: o.id, revision: task.revision });
  const source = { kind: store.commandActor === 'operator' ? 'operator' : 'orchestrator', ref: `Reopens decision ${o.id}: its scope was removed at revision ${removal.revisedRevision}, which revision ${task.revision} is not.` };
  const reopened = { schemaVersion: RECORD_SCHEMA_VERSION, id: decisionId, projectId, taskId: task.id, originRevision: task.revision, version: 1, owner: 'operator', source, question: o.question, ...(o.rationale !== undefined ? { rationale: o.rationale } : {}), scope: o.scope, scopeDigest: o.scopeDigest, options: o.options, optionSetDigest: o.optionSetDigest, requiredAt: [...o.requiredAt], applicability: [{ taskId: task.id, revision: task.revision, state: 'pending' }], status: 'unresolved', activeDispositionId: null, reopens: o.id, createdAt: at, updatedAt: at };
  putAuthorityRecord(store, 'decisionObligation', reopened);
  recordAuthorityRaces(store, reopened, 'task.put');
  store.event('decision.reopened', { decisionId, reopens: o.id, taskId: task.id, revision: task.revision, removedAt: removal.revisedRevision });
  return reopened;
}

// task.put carry-forward: a new revision of a task inherits every decision that
// applied to the previous one. Unresolved decisions stay pending on it; settled
// ones need confirmation there, because an answer never silently follows a
// changed brief. A revision that returns to an earlier value keeps its entry.
// Superseded decisions are final and never carried; a scope removal that does
// not clear the new revision reopens its choice there instead (see removalOf).
export function carryDecisionsForward(store, task, previousRevision) {
  if (!authorityLedgerEnabled(store) || !previousRevision || previousRevision === task.revision) return [];
  const carried = [], reopened = [];
  for (const o of taskDecisions(store, task.id)) {
    if (o.status === 'superseded' || !o.applicability.some(a => a.taskId === task.id && a.revision === previousRevision) || o.applicability.some(a => a.taskId === task.id && a.revision === task.revision)) continue;
    assert(o.applicability.length < MAX_APPLICABILITY, `task.put refused: decision ${o.id} already applies to ${MAX_APPLICABILITY} task revisions, the most one decision records, and this edit would add another. Settle the choice in a new decision first: open a decision on the current revision (decision.open), supersede ${o.id} with it (decision.dispose kind "supersede", replacements [the new decision]), then edit the task again`);
    writeDecision(store, o, { applicability: [...o.applicability, { taskId: task.id, revision: task.revision, state: o.status === 'unresolved' ? 'pending' : 'requires-confirmation' }] }, 'the task brief changed; present the decision again');
    carried.push(o.id);
  }
  for (const o of taskDecisions(store, task.id)) {
    const removal = removalOf(store, o);
    if (!removal || reopenedAt(store, o, task.revision)) continue;
    const back = task.revision !== removal.revisedRevision && o.applicability.some(a => a.revision === task.revision);
    const leaving = clearedByRemoval(store, o, removal, previousRevision) && !clearedByRemoval(store, o, removal, task.revision);
    if (back || leaving) reopened.push(reopenDecision(store, o, removal, task).id);
  }
  if (carried.length || reopened.length) {
    bumpTaskAuthority(store, task.id, 'decision-carry-forward', task.revision);
    if (carried.length) store.event('decision.carried-forward', { taskId: task.id, previousRevision, revision: task.revision, decisions: carried });
    if (reopened.length) requeueRoutineSummaries(store, task.id);
    assertTaskRecordsSound(store, task.id, 'task.put');
  }
  return [...carried, ...reopened];
}

// A direct operator authority use for exactly one disposition of one command. Its
// subject digest is the disposition's exact subject (see authoritySubjectDigest).
const directUse = (store, d, { operation, disposition }) => ({ schemaVersion: RECORD_SCHEMA_VERSION, id: digest({ kind: 'authorityUse', projectId: projectOf(store), commandId: d.commandId, dispositionId: d.id }), projectId: projectOf(store), source: 'direct-operator', commandId: d.commandId, operation, subjectDigest: authoritySubjectDigest(dispositionSubject(d)), disposition, consumptionKey: digest({ commandId: d.commandId, operation, dispositionId: d.id }), derived: [{ kind: 'decisionDisposition', id: d.id }], createdAt: d.createdAt, status: 'active', version: 1 });

function deactivate(store, disposition, reason) {
  const at = now(), inactive = { inactiveReason: reason, inactiveAt: at };
  putAuthorityRecord(store, 'decisionDisposition', { ...disposition, ...inactive, status: 'inactive', version: disposition.version + 1 }, { expectedVersion: disposition.version });
  const use = store.get('authorityUse', disposition.authorityUseId);
  if (use?.status === 'active') putAuthorityRecord(store, 'authorityUse', { ...use, ...inactive, status: 'inactive', version: use.version + 1 }, { expectedVersion: use.version });
}
// A clearance whose grant was revoked or expired: the disposition and its use become
// inactive history and the decision unresolved, exactly as a direct revocation leaves
// it, so ratification or a fresh disposition is needed. Effects already dispatched
// are recorded as authority races, never undone.
export function lapseClearance(store, d, reason) {
  const o = store.need('decisionObligation', d.obligationId);
  deactivate(store, d, reason);
  if (o.activeDispositionId !== d.id) return o;
  const reopened = writeDecision(store, o, { status: 'unresolved', activeDispositionId: null, applicability: pendingEntries(o) }, reason);
  recordAuthorityRaces(store, reopened, reason.startsWith('grant') && reason.includes('expired') ? 'grant expiry' : 'grant.revoke');
  requeueRoutineSummaries(store, o.taskId);
  store.event('decision.clearance-lapsed', { decisionId: o.id, dispositionId: d.id, reason });
  return reopened;
}
// Read a decision at the version the caller read. A clearance that lapsed with its
// grant since then is first recorded as lapsed (in this command), so the operator can
// ratify or answer the version they were shown.
function readDecision(store, p, operation) {
  let o = store.need('decisionObligation', id(p.decisionId, 'decision id'));
  assert(p.expectedDecisionVersion === o.version, `decision ${o.id} changed; expected version ${p.expectedDecisionVersion}, found ${o.version}; read it again`);
  const lapse = clearanceLapse(store, o);
  if (lapse) {
    lapseClearance(store, store.need('decisionDisposition', o.activeDispositionId), `${lapse} (recorded by ${operation})`);
    bumpTaskAuthority(store, o.taskId, 'grant-expiry', o.id);
    o = store.need('decisionObligation', o.id);
  }
  return o;
}
// Settle an unresolved decision version with a new active disposition covering all of its revisions.
function settle(store, o, d, use, { supersededBy } = {}) {
  putAuthorityRecord(store, 'authorityUse', use);
  putAuthorityRecord(store, 'decisionDisposition', d);
  return writeDecision(store, o, { status: d.kind === 'answer' ? 'resolved' : STATUS_OF[d.kind], activeDispositionId: d.id, applicability: o.applicability.map(({ taskId, revision }) => ({ taskId, revision, state: 'covered', dispositionId: d.id })), ...(supersededBy ? { supersededBy } : {}) }, 'the decision was settled');
}

// Replacements carry the hold of a superseded decision: they must exist, belong
// to the same task, apply to its current revision, still hold (not superseded)
// and not lead back to the decision they replace.
function checkReplacements(store, o, task, replacements) {
  assert(Array.isArray(replacements) && replacements.length <= 16 && new Set(replacements).size === replacements.length, 'replacements is a list of up to 16 distinct decision ids');
  for (const replacementId of replacements) {
    id(replacementId, 'replacement decision id'); assert(replacementId !== o.id, 'a decision cannot supersede itself');
    const r = store.get('decisionObligation', replacementId);
    assert(r, `replacement decision ${replacementId} does not exist; open it first`);
    assert(r.taskId === o.taskId && r.applicability.some(a => a.revision === task.revision), `replacement decision ${replacementId} must apply to task ${o.taskId} at its current revision`);
    assert(r.status !== 'superseded', `replacement decision ${replacementId} is itself superseded`);
    // Superseded decisions are final, so no cycle can form; check the chain anyway.
    const seen = new Set(), walk = [replacementId];
    while (walk.length) { const at = walk.pop(); assert(at !== o.id, 'supersession would form a cycle'); if (seen.has(at)) continue; seen.add(at); walk.push(...(store.get('decisionObligation', at)?.supersededBy ?? [])); }
  }
}
function descendsFrom(store, taskId, revision, ancestor) {
  const projectId = projectOf(store), seen = new Set([revision]);
  let snapshot = store.get('taskRevision', taskRevisionId(projectId, taskId, revision));
  while (snapshot?.previousRevision && !seen.has(snapshot.previousRevision)) {
    if (snapshot.previousRevision === ancestor) return true;
    seen.add(snapshot.previousRevision); snapshot = store.get('taskRevision', taskRevisionId(projectId, taskId, snapshot.previousRevision));
  }
  return false;
}

// decision.dispose: the direct operator answers, cancels or supersedes the exact
// decision version read. A settled decision that needs confirmation on a newer
// revision is disposed of anew: its old disposition becomes inactive history.
// The orchestrator may answer or cancel only by citing a grant entry that pins this
// exact decision version, scope, options and answer or cancellation payload; the
// entry is consumed in this command. The operator may cite a pending relayed answer
// (relayedAnswerId) it confirms; a grant-backed answer may carry the relay it acts on.
export function disposeDecision(store, p, context) {
  requireLedger(store, 'decision.dispose');
  const granted = context.actor !== 'operator' || Boolean(context.onBehalfOf);
  if (granted) assert(store.commandAuthority?.ref && !store.commandAuthority.used, `decision.dispose ${GRANT_OR_RELAY}`);
  only(p, ['decisionId', 'expectedDecisionVersion', 'kind', 'optionId', 'rationale', 'reason', 'replacements', 'removedScope', 'evidence', 'inboxId', 'relayedAnswerId', 'relay'], 'decision.dispose');
  assert(p.relayedAnswerId === undefined || !granted, 'only the operator confirms a relayed answer, directly; a grant-backed answer records the relay it acts on (relay)');
  assert(p.relay === undefined || granted, 'the operator answers directly; relay records words someone else entered on the operator\'s behalf');
  const commandId = commandOf(store, 'decision.dispose');
  let o = readDecision(store, p, 'decision.dispose');
  const read = o.version;
  assert(o.status !== 'superseded', `decision ${o.id} is superseded; its replacements carry the hold`);
  assert(!settledFor(o), `decision ${o.id} is already ${o.status} for every revision it applies to; revoke its disposition first to change it`);
  assert(['answer', 'cancel', 'supersede'].includes(p.kind), 'kind is answer, cancel or supersede');
  if (granted) {
    // Whoever enters an answer other than the operator relays it: the operator's words
    // verbatim and where they were said. A grant makes the relayed answer effective; it
    // does not replace the record of what the operator said.
    if (p.kind === 'answer') assert(p.relay !== undefined, `a grant-backed answer is entered by the ${context.actor} on the operator's behalf, so it must carry relay {quote, channel}: the operator's words verbatim and where they were said`);
    assert(p.kind !== 'supersede', 'supersession is final, so it needs the operator directly; a grant authorizes answer or cancel');
    assert(o.status === 'unresolved', `decision ${o.id} is ${o.status} and needs confirmation on the current revision; that needs the operator directly`);
  }
  const task = store.need('task', o.taskId);
  assert(o.applicability.some(a => a.revision === task.revision), `decision ${o.id} does not apply to the current revision of task ${task.id}`);
  const rationale = text(p.rationale, 'rationale');
  if (p.evidence !== undefined) assert(Array.isArray(p.evidence) && p.evidence.length >= 1 && p.evidence.length <= 16 && p.evidence.every(x => typeof x === 'string' && x.trim() && x.length <= 500), 'evidence is a list of up to 16 short references');
  for (const [field, kinds] of [['optionId', ['answer']], ['reason', ['cancel']], ['replacements', ['supersede']], ['removedScope', ['supersede']], ['relayedAnswerId', ['answer']], ['relay', ['answer']]]) assert(p[field] === undefined || kinds.includes(p.kind), `${field} does not apply to a ${p.kind} disposition`);
  let payload;
  if (p.kind === 'answer') {
    const option = o.options.find(x => x.id === p.optionId); assert(option, `option ${p.optionId} is not one of decision ${o.id}'s options`);
    payload = { answer: { optionId: option.id, payloadDigest: option.payloadDigest } };
  } else if (p.kind === 'cancel') payload = { cancellation: { scopeDigest: o.scopeDigest, reason: text(p.reason, 'cancellation reason') } };
  else {
    const replacements = p.replacements ?? [];
    checkReplacements(store, o, task, replacements);
    assert(replacements.length || p.removedScope !== undefined, 'supersession needs replacement decisions, or removedScope tied to a revised brief');
    // A scope removal, alone or beside replacements, is tied to the revised brief
    // that removed it: the current revision, recorded later than the origin.
    if (p.removedScope !== undefined) assert(task.revision !== o.originRevision && descendsFrom(store, task.id, task.revision, o.originRevision), 'a scope removal must be tied to a revised brief: edit the task first, then supersede on its new revision');
    payload = { supersession: { replacements, ...(p.removedScope !== undefined ? { removedScope: text(p.removedScope, 'removed scope'), revisedRevision: task.revision } : {}) } };
  }
  const dispositionId = digest({ kind: 'decisionDisposition', projectId: projectOf(store), commandId, decisionId: o.id });
  // The operator confirms a relayed answer by citing it: the same decision version read and the same option.
  let relayedAnswerId;
  if (p.relayedAnswerId !== undefined) {
    const r = store.need('relayedAnswer', id(p.relayedAnswerId, 'relayed answer id'));
    assert(r.decisionId === o.id && r.status === 'pending' && r.decisionVersion === read, `relayed answer ${r.id} is not a pending relay of decision ${o.id} version ${read}`);
    assert(r.selected.optionId === p.optionId, `relayed answer ${r.id} relayed option ${r.selected.optionId}, not ${p.optionId}; answer without citing it`);
    putAuthorityRecord(store, 'relayedAnswer', { ...r, status: 'confirmed', dispositionId, resolvedAt: now(), version: r.version + 1 }, { expectedVersion: r.version });
    retireRelayNotice(store, r, 'confirmed by the operator');
    relayedAnswerId = r.id;
  }
  // Reopen a settled version (needing confirmation) before disposing anew.
  if (o.status !== 'unresolved') {
    deactivate(store, store.need('decisionDisposition', o.activeDispositionId), `replaced by a disposition covering revision ${task.revision}`);
    o = writeDecision(store, o, { status: 'unresolved', activeDispositionId: null, applicability: pendingEntries(o) }, 'the decision is being disposed of anew');
  }
  const d = { schemaVersion: RECORD_SCHEMA_VERSION, id: dispositionId, projectId: projectOf(store), obligationId: o.id, obligationVersion: o.version, applicability: o.applicability.map(({ taskId, revision }) => ({ taskId, revision })), scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, kind: p.kind, ...payload, rationale, ...(p.evidence ? { evidence: p.evidence } : {}), authorityUseId: '', commandId, createdAt: now(), status: 'active', version: 1 };
  let useRow;
  if (granted) {
    if (p.relay !== undefined) relayedAnswerId = writeRelay(store, o, task, { optionId: p.optionId, relay: p.relay, inboxId: p.inboxId, status: 'applied', dispositionId }).id;
    if (relayedAnswerId) d.relayedAnswerId = relayedAnswerId;
    useRow = consumeGrant(store, context, { operation: 'decision.dispose', disposition: p.kind, taskId: task.id, taskRevision: task.revision, subject: dispositionSubject(d), derived: [{ kind: 'decisionDisposition', id: d.id }],
      check: entry => {
        const where = `grant entry ${entry.entryId}`;
        assert(entry.obligationId === o.id && entry.obligationVersion === o.version, `${where} pins decision ${entry.obligationId} version ${entry.obligationVersion}, not ${o.id} version ${o.version}`);
        assert(entry.scopeDigest === o.scopeDigest && entry.optionSetDigest === o.optionSetDigest, `${where} pins a different scope or option set than decision ${o.id} now has`);
        assert(o.applicability.length === 1, `decision ${o.id} applies to ${o.applicability.length} task revisions; a grant covers exactly one`);
        if (p.kind === 'answer') assert(entry.answers.some(a => a.optionId === payload.answer.optionId && a.payloadDigest === payload.answer.payloadDigest), `${where} does not permit answer ${p.optionId}`);
        else assert(entry.payloadDigest === dispositionPayloadDigest(d), `${where} pins a different cancellation (its reason must match exactly)`);
      } });
  } else {
    if (relayedAnswerId) d.relayedAnswerId = relayedAnswerId;
    useRow = directUse(store, d, { operation: 'decision.dispose', disposition: p.kind });
  }
  d.authorityUseId = useRow.id;
  const settled = settle(store, o, d, useRow, p.kind === 'supersede' && payload.supersession.replacements.length ? { supersededBy: payload.supersession.replacements } : {});
  const authorityRevision = bumpTaskAuthority(store, task.id, 'decision-disposition', o.id);
  assertTaskRecordsSound(store, task.id, 'decision.dispose');
  store.event('decision.disposed', { decisionId: o.id, dispositionId, kind: p.kind, ...(p.kind === 'answer' ? { optionId: p.optionId } : {}), revisions: revisions(d), authorityRevision, authority: useRow.source, ...(useRow.grantId ? { grantId: useRow.grantId, entryId: useRow.entryId } : {}), ...(relayedAnswerId ? { relayedAnswerId } : {}), ...(p.inboxId ? { inboxId: p.inboxId } : {}) });
  return { decision: settled, disposition: d, authorityUse: useRow, authorityRevision, ...(relayedAnswerId ? { relayedAnswerId } : {}) };
}

// A relayed answer: exactly the operator's words, the channel they came from, who
// relayed them (the command's actor, never a payload field) and the option the
// relayer mapped them to. Nothing else is accepted or added. That mapping (selected) is
// the relayer's interpretation, not the operator's words: it takes effect only when the
// operator confirms it directly or an exact grant entry permits that very answer.
function relayOf(relay) {
  assert(relay && typeof relay === 'object' && !Array.isArray(relay) && Object.keys(relay).every(k => ['quote', 'channel'].includes(k)), 'relay is {quote, channel}: the operator\'s words verbatim and where they were said; nothing else (who relayed it is the command\'s actor)');
  return { quote: text(relay.quote, 'relay quote (the operator\'s words, verbatim)'), channel: text(relay.channel, 'relay channel', 200) };
}
function writeRelay(store, o, task, { optionId, relay, inboxId, status = 'pending', dispositionId }) {
  const option = o.options.find(x => x.id === optionId); assert(option, `option ${optionId} is not one of decision ${o.id}'s options`);
  const commandId = commandOf(store, 'relay'), words = relayOf(relay);
  const r = { schemaVersion: RECORD_SCHEMA_VERSION, id: digest({ kind: 'relayedAnswer', projectId: projectOf(store), commandId, decisionId: o.id }), projectId: projectOf(store), decisionId: o.id, decisionVersion: o.version, taskId: task.id, taskRevision: task.revision, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, selected: { optionId: option.id, payloadDigest: option.payloadDigest }, relayedBy: 'orchestrator', ...words, commandId, createdAt: now(), status, version: 1, ...(inboxId !== undefined ? { inboxId } : {}), ...(dispositionId ? { dispositionId } : {}) };
  putAuthorityRecord(store, 'relayedAnswer', r);
  store.event('decision.relayed', { decisionId: o.id, relayedAnswerId: r.id, optionId: option.id, channel: r.channel, status, ...(inboxId ? { inboxId } : {}) });
  return r;
}
const relayNoticeId = r => `relayed-answer:${r.id}`;
function retireRelayNotice(store, r, reason) {
  const notice = store.get('inbox', relayNoticeId(r));
  if (notice?.status === 'open') { store.put('inbox', { ...notice, status: 'superseded', supersededReason: reason, version: notice.version + 1 }); store.event('inbox.superseded', { inboxId: notice.id, reason }); }
}
// Pending relays of an older decision version can no longer be confirmed as they are.
function supersedeRelays(store, o, reason) {
  for (const r of store.all('relayedAnswer').filter(x => x.decisionId === o.id && x.status === 'pending' && (x.decisionVersion < o.version || settledFor(o)))) {
    putAuthorityRecord(store, 'relayedAnswer', { ...r, status: 'superseded', resolvedAt: now(), resolvedReason: reason, version: r.version + 1 }, { expectedVersion: r.version });
    retireRelayNotice(store, r, reason);
  }
}
// decision.relay (and an orchestrator's card answer carrying relay without a grant):
// keep the operator's words as evidence and present them for confirmation. The
// decision stays unresolved; only a direct operator disposition citing the relay, or a
// grant-backed answer, settles it.
export function relayDecision(store, p, context) {
  requireLedger(store, 'decision.relay');
  assert(context.actor !== 'operator', 'the operator answers directly (decision.dispose); decision.relay records words someone else entered on the operator\'s behalf');
  assert(!store.commandAuthority?.ref, 'decision.relay cannot use a grant; send decision.dispose with the grant reference instead');
  only(p, ['decisionId', 'expectedDecisionVersion', 'optionId', 'quote', 'channel', 'inboxId'], 'decision.relay');
  const o = readDecision(store, p, 'decision.relay'), task = store.need('task', o.taskId);
  assert(o.status !== 'superseded' && !settledFor(o), `decision ${o.id} is settled for every revision it applies to; nothing to relay`);
  assert(o.applicability.some(a => a.revision === task.revision), `decision ${o.id} does not apply to the current revision of task ${task.id}`);
  const r = writeRelay(store, o, task, { optionId: p.optionId, relay: { quote: p.quote, channel: p.channel }, inboxId: p.inboxId });
  const option = o.options.find(x => x.id === r.selected.optionId);
  store.put('inbox', { id: relayNoticeId(r), kind: 'notice', status: 'open', version: 1, role: 'operator', taskId: o.taskId, decisionId: o.id, relayedAnswerId: r.id, title: `Relayed answer awaits your confirmation: ${o.question.slice(0, 120)}`, context: `The ${context.actor} relayed your words from ${r.channel}: “${r.quote}”. It mapped them to option “${option.label}” (${option.id}). Decision ${o.id} stays unresolved and keeps holding ${o.requiredAt.join(', ')} until you answer it directly; you can cite this relay (relayedAnswerId ${r.id}) when you do.`, createdAt: now() });
  assertTaskRecordsSound(store, task.id, 'decision.relay');
  return { relayedAnswer: r, decisionRemains: o.id };
}

// decision.revoke: the direct operator withdraws a decision's active disposition.
// The decision becomes unresolved again; the disposition and its authority use
// stay as inactive history. A protected effect already dispatched is recorded as
// an authority race, not undone.
export function revokeDecision(store, p, context) {
  requireLedger(store, 'decision.revoke'); direct(context, 'decision.revoke');
  only(p, ['decisionId', 'expectedDecisionVersion', 'dispositionId', 'reason'], 'decision.revoke');
  const o = readDecision(store, p, 'decision.revoke');
  assert(o.status !== 'superseded', `decision ${o.id} is superseded, which is final; its replacements carry the hold`);
  assert(o.status !== 'unresolved' && o.activeDispositionId === p.dispositionId, `disposition ${p.dispositionId} is not the active disposition of decision ${o.id}`);
  const reason = text(p.reason, 'revocation reason', 1000);
  deactivate(store, store.need('decisionDisposition', o.activeDispositionId), `revoked by the operator: ${reason}`);
  const reopened = writeDecision(store, o, { status: 'unresolved', activeDispositionId: null, applicability: pendingEntries(o) }, 'the decision was revoked');
  const authorityRevision = bumpTaskAuthority(store, o.taskId, 'decision-revocation', o.id);
  assertTaskRecordsSound(store, o.taskId, 'decision.revoke');
  const races = recordAuthorityRaces(store, reopened, 'decision.revoke');
  requeueRoutineSummaries(store, o.taskId);
  store.event('decision.revoked', { decisionId: o.id, dispositionId: p.dispositionId, reason, authorityRevision, races: races.map(r => r.attemptId) });
  return { decision: reopened, revokedDispositionId: p.dispositionId, authorityRevision, authorityRaces: races };
}

// Inactive answers of an unresolved decision that ratification could restore now.
function ratifiable(store, o, task) {
  // A clearance that lapsed with its grant is ratifiable once the lapse is recorded,
  // which the ratification itself does first.
  if (task && clearanceLapse(store, o)) { const d = store.get('decisionDisposition', o.activeDispositionId); return d?.kind === 'answer' && revisions(d).includes(`${task.id}@${task.revision}`) ? [d] : []; }
  if (o.status !== 'unresolved' || !task) return [];
  const all = store.all('decisionDisposition').filter(d => d.obligationId === o.id), ratified = new Set(all.map(d => d.ratifiesDispositionId).filter(Boolean));
  return all.filter(d => d.status === 'inactive' && d.kind === 'answer' && !ratified.has(d.id) && d.scopeDigest === o.scopeDigest && d.optionSetDigest === o.optionSetDigest && sameRevisions(revisions(d), revisions(o)) && revisions(d).includes(`${task.id}@${task.revision}`));
}
// decision.ratify: the direct operator restores one inactive answer unchanged,
// only while the decision's revisions, scope and options are what it answered.
export function ratifyDecision(store, p, context) {
  requireLedger(store, 'decision.ratify'); direct(context, 'decision.ratify');
  only(p, ['decisionId', 'expectedDecisionVersion', 'inactiveDispositionId', 'rationale'], 'decision.ratify');
  const commandId = commandOf(store, 'decision.ratify');
  const o = readDecision(store, p, 'decision.ratify');
  assert(o.status === 'unresolved', `decision ${o.id} is ${o.status}; only an unresolved decision can be ratified`);
  const prior = store.need('decisionDisposition', id(p.inactiveDispositionId, 'disposition id')), task = store.need('task', o.taskId);
  assert(prior.obligationId === o.id && prior.status === 'inactive' && prior.kind === 'answer', `disposition ${prior.id} is not an inactive answer of decision ${o.id}`);
  assert(!store.all('decisionDisposition').some(d => d.ratifiesDispositionId === prior.id), `disposition ${prior.id} was already ratified once; ratify its ratification or answer anew`);
  assert(prior.scopeDigest === o.scopeDigest && prior.optionSetDigest === o.optionSetDigest, `decision ${o.id} scope or options changed since ${prior.id}; answer anew`);
  assert(sameRevisions(revisions(prior), revisions(o)) && revisions(prior).includes(`${task.id}@${task.revision}`), `decision ${o.id} now applies to revisions ${prior.id} did not answer (task ${task.id} is at ${task.revision}); answer anew`);
  const rationale = text(p.rationale, 'rationale');
  const dispositionId = digest({ kind: 'decisionDisposition', projectId: projectOf(store), commandId, decisionId: o.id });
  const d = { schemaVersion: RECORD_SCHEMA_VERSION, id: dispositionId, projectId: projectOf(store), obligationId: o.id, obligationVersion: o.version, applicability: prior.applicability.map(({ taskId, revision }) => ({ taskId, revision })), scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, kind: 'answer', answer: { ...prior.answer }, rationale, ratifiesDispositionId: prior.id, authorityUseId: '', commandId, createdAt: now(), status: 'active', version: 1 };
  const use = directUse(store, d, { operation: 'decision.ratify', disposition: 'ratify' });
  d.authorityUseId = use.id;
  const settled = settle(store, o, d, use);
  const authorityRevision = bumpTaskAuthority(store, o.taskId, 'decision-disposition', o.id);
  assertTaskRecordsSound(store, o.taskId, 'decision.ratify');
  store.event('decision.ratified', { decisionId: o.id, dispositionId, ratifies: prior.id, authorityRevision });
  return { decision: settled, disposition: d, authorityUse: use, authorityRevision };
}

// decision.present (and inbox.publish purpose "decision"): a versioned card for
// the decision's current version. The card is presentation only.
export function presentDecision(store, p, { actor }) {
  requireLedger(store, 'decision.present');
  only(p, ['decisionId', 'expectedDecisionVersion', 'id', 'title', 'context', 'expiryMs', 'remind', 'discuss', 'links', 'taskId', 'taskRevision', 'scopeDigest'], 'decision.present');
  const o = readDecision(store, p, 'decision.present'), task = store.need('task', o.taskId);
  for (const [field, value] of [['taskId', o.taskId], ['taskRevision', task.revision], ['scopeDigest', o.scopeDigest]]) assert(p[field] === undefined || p[field] === value, `${field} does not match decision ${o.id}'s current ${field}`);
  assert(o.status !== 'superseded' && !settledFor(o), `decision ${o.id} is settled for every revision it applies to; nothing to present`);
  assert(o.applicability.some(a => a.revision === task.revision), `decision ${o.id} does not apply to the current revision of task ${task.id}`);
  const open = store.all('inbox').find(row => row.purpose === 'decision' && row.status === 'open' && row.decision?.decisionId === o.id && row.decision.version === o.version);
  assert(!open, `decision ${o.id} version ${o.version} is already presented as inbox item ${open?.id}`);
  assert(p.discuss === undefined || typeof p.discuss === 'boolean', 'discuss must be true or false');
  const choices = [...o.options.map(option => ({ id: option.id, label: option.label, disposition: { kind: 'answer', optionId: option.id } })), ...(p.discuss === false ? [] : [{ id: DISCUSS, label: 'Discuss first (leaves the decision unresolved)', disposition: { kind: 'none' } }])];
  const card = publishDecisionCard(store, { id: p.id, title: p.title ?? `Decision needed: ${task.title}`, context: p.context ?? `${o.rationale ? `${o.rationale}\n\n` : ''}Task ${task.id} at revision ${task.revision.slice(0, 12)}. This decision holds ${o.requiredAt.join(', ')} until the operator answers it. Withdrawing or letting this card expire leaves the decision unresolved.`, question: o.question, choices, expiryMs: p.expiryMs, remind: p.remind, links: p.links,
    decision: { decisionId: o.id, version: o.version, taskId: o.taskId, taskRevision: task.revision, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, requiredAt: [...o.requiredAt] } }, actor);
  store.event('decision.presented', { decisionId: o.id, version: o.version, inboxId: card.id, actor });
  return card;
}

// The answer to a bound card. An option chosen by the operator is a direct
// disposition of the exact decision version the card shows. Chosen by anyone else it
// settles the decision only through a grant entry covering that exact answer
// (authority); without one, a relay {quote, channel} is kept as a relayed answer for
// the operator to confirm and the card stays open. "discuss" records the reply and
// leaves the decision unresolved.
export function answerDecisionCard(store, item, p, context) {
  requireLedger(store, 'answer');
  only(p, ['inboxId', 'version', 'subjectDigest', 'answer', 'note', 'relay', 'relayedAnswerId'], 'answering a decision card');
  assertCurrentQuestion(item, { version: p.version, subjectDigest: p.subjectDigest });
  assert(Date.parse(item.expiresAt) > Date.now(), 'question expired');
  const choice = item.choices.find(row => row.id === p.answer); assert(choice, 'invalid answer');
  const o = store.need('decisionObligation', item.decision.decisionId);
  assert(o.version === item.decision.version, `decision ${o.id} changed since this card was presented (card version ${item.decision.version}, decision version ${o.version}); present it again`);
  if (p.note !== undefined) text(p.note, 'answer note');
  const operator = context.actor === 'operator' && !context.onBehalfOf, granted = !operator && Boolean(store.commandAuthority?.ref);
  if (choice.disposition.kind === 'none') {
    assert(context.actor === 'operator' || context.delegated, 'standalone questions require the operator');
    assert(p.relay === undefined && p.relayedAnswerId === undefined && !store.commandAuthority?.ref, '"discuss" settles nothing; it takes no relay, relayed answer or grant');
  } else if (granted) {
    assert(p.relay !== undefined, `answering a decision card through a grant is entered by the ${context.actor} on the operator's behalf, so it must carry relay {quote, channel}: the operator's words verbatim and where they were said`);
  } else if (!operator) {
    // Words the operator said elsewhere, entered on their behalf without a grant: evidence only.
    assert(p.relay !== undefined, `answering a decision ${GRANT_OR_RELAY}`);
    assert(p.relayedAnswerId === undefined, 'only the operator confirms a relayed answer');
    const relayed = relayDecision(store, { decisionId: o.id, expectedDecisionVersion: o.version, optionId: choice.disposition.optionId, ...relayOf(p.relay), inboxId: item.id }, context);
    store.event('inbox.relayed', { inboxId: item.id, answer: p.answer, actor: context.actor, decisionId: o.id, relayedAnswerId: relayed.relayedAnswer.id });
    return { ...item, relayedAnswerId: relayed.relayedAnswer.id, decisionRemains: o.id };
  }
  Object.assign(item, { status: 'answered', answer: p.answer, answeredBy: context.actor, answeredAt: now(), ...(p.note !== undefined ? { answerNote: p.note } : {}) }); item.version++;
  const wait = store.get('wait', `question:${item.id}`); if (wait && !wait.endedAt) store.put('wait', { ...wait, endedAt: item.answeredAt, reason: 'answered' });
  store.put('inbox', item);
  let disposed = null;
  if (choice.disposition.kind === 'answer') disposed = disposeDecision(store, { decisionId: o.id, expectedDecisionVersion: o.version, kind: 'answer', optionId: choice.disposition.optionId, rationale: p.note ?? `Answered “${choice.label}” on inbox item ${item.id}.`, inboxId: item.id, ...(p.relay !== undefined ? { relay: p.relay } : {}), ...(p.relayedAnswerId !== undefined ? { relayedAnswerId: p.relayedAnswerId } : {}) }, context);
  store.event('inbox.answered', { inboxId: item.id, answer: p.answer, actor: context.actor, standalone: true, decisionId: o.id, resolving: Boolean(disposed), ...(disposed ? { authority: disposed.authorityUse.source } : {}) });
  return { ...item, ...(disposed ? { dispositionId: disposed.disposition.id, ...(disposed.relayedAnswerId ? { relayedAnswerId: disposed.relayedAnswerId } : {}) } : { decisionRemains: o.id }) };
}

// Read projections: the durable decision, separate from its cards.
export function decisionView(store, o) {
  const task = store.get('task', o.taskId), hold = task ? holdOf(store, o, task.id, task.revision) : null, lapse = clearanceLapse(store, o);
  const dispositions = store.all('decisionDisposition').filter(d => d.obligationId === o.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const cards = store.all('inbox').filter(row => row.purpose === 'decision' && row.decision?.decisionId === o.id).map(row => ({ id: row.id, status: row.status, version: row.version, decisionVersion: row.decision.version, createdAt: row.createdAt }));
  return { ...o, currentRevision: task?.revision ?? null, appliesToCurrentRevision: Boolean(task && o.applicability.some(a => a.revision === task.revision)), blocks: hold?.boundaries ?? [], holdReason: hold?.reason ?? null,
    dispositions: dispositions.map(({ id: dispositionId, kind, status, answer, cancellation, supersession, rationale, applicability, obligationVersion, ratifiesDispositionId, commandId, createdAt, inactiveReason, inactiveAt }) => ({ id: dispositionId, kind, status, answer, cancellation, supersession, rationale, revisions: applicability.map(a => a.revision), obligationVersion, ratifiesDispositionId, commandId, createdAt, inactiveReason, inactiveAt })),
    ratifiable: ratifiable(store, o, task).map(d => d.id), cards,
    ...(lapse ? { clearanceLapse: lapse } : {}),
    relayedAnswers: store.all('relayedAnswer').filter(r => r.decisionId === o.id).map(({ id: relayId, decisionVersion, selected, relayedBy, quote, channel, status, dispositionId, createdAt, resolvedReason, inboxId }) => ({ id: relayId, decisionVersion, optionId: selected.optionId, relayedBy, quote, channel, status, dispositionId, createdAt, resolvedReason, inboxId })),
    grantCoverage: store.all('operatorGrant').flatMap(g => g.entries.filter(e => e.obligationId === o.id).map(e => ({ grantId: g.id, entryId: e.entryId, disposition: e.disposition, obligationVersion: e.obligationVersion, answers: e.answers?.map(a => a.optionId), used: g.usage[e.entryId] ?? 0, maxUses: e.maxUses, status: g.status, expiresAt: g.expiresAt, current: !grantLapse(g) && e.obligationVersion === o.version }))) };
}
export const decisionViews = (store, { limit = 100 } = {}) => {
  if (!authorityLedgerEnabled(store)) return [];
  const all = store.all('decisionObligation'), open = all.filter(o => o.status !== 'superseded' && (o.status === 'unresolved' || o.status === 'canceled' || !settledFor(o)));
  const recent = all.filter(o => !open.includes(o)).slice(-20);
  return [...open, ...recent].slice(-limit).map(o => decisionView(store, o));
};
// Holds on a task's current revision, for task views and queue diagnostics.
export function taskDecisionSummary(store, task) {
  if (!authorityLedgerEnabled(store)) return undefined;
  return decisionHolds(store, task.id, task.revision).map(hold => ({ ...hold, summary: holdReason(hold) }));
}

// Engine helpers. A held flow waits at its step with a visible reason and owns
// no attempt; it continues on a later tick once the hold clears. Holds add
// reasons, never permits: capacity and ownership are unchanged.
export function markDecisionHold(store, flow, step, boundary, holds) {
  const hold = { step, boundary, decisions: holds.map(h => ({ decisionId: h.decisionId, version: h.version })), reasons: holds.map(h => holdReason(h, boundary)) };
  const changed = digest({ ...(flow.decisionHold ?? {}), since: null }) !== digest({ ...hold, since: null }) || flow.state !== 'waiting';
  if (!changed) return true;
  flow.decisionHold = { ...hold, since: now() }; flow.state = 'waiting'; store.put('flow', flow);
  store.event('flow.decision-held', { flowId: flow.id, taskId: flow.taskId, step, boundary, decisions: hold.decisions.map(d => d.decisionId) });
  return true;
}
export function clearDecisionHold(store, flow) {
  if (!flow.decisionHold) return;
  const { step, boundary } = flow.decisionHold; delete flow.decisionHold;
  if (flow.state === 'waiting') flow.state = 'ready';
  store.put('flow', flow); store.event('flow.decision-released', { flowId: flow.id, step, boundary });
}
