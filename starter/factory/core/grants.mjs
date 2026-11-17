// Exact stored operator grants (plans 7/8, slice C).
//
// grant.issue and grant.revoke are direct operator commands: the orchestrator can
// never issue itself authority, and neither can be delegated. A grant lists exact
// entries (a task revision and workflow to approve, or a decision version with its
// exact allowed answers or cancellation payload); nothing is matched by prose or
// wildcard. The grantee (the orchestrator) cites one entry per command with the
// envelope's `authority: {grantId, entryId, expectedVersion}`, which executeCommand
// includes in the command digest and receipt. An entry is consumed only when the
// protected operation commits, inside the command's application savepoint, so a
// rejected or rolled-back command consumes nothing and a replayed command id returns
// its first receipt without a second use.
//
// Consumption does not make the resulting approval or clearance permanent: it stays
// usable only while its grant is unrevoked and unexpired. Revocation and expiry
// invalidate derived approvals and clearances going forward (the dispatch fence reads
// them) without undoing effects already performed.
//
// Everything here is active only on a migrated (schema 2) database.
import { assert, digest, id, now } from './contracts.mjs';
import { approvalSubject, auditAuthorityRecords, authorityLedgerEnabled, authoritySubjectDigest, bumpTaskAuthority, putAuthorityRecord, RECORD_SCHEMA_VERSION, taskRevisionId } from './decision-authority.mjs';
import { approvalBinding } from './catalog.mjs';

// The longest validity one grant may have. Short-lived authority is the conservative default.
export const MAX_GRANT_MS = 30 * 24 * 3600 * 1000;
// Operations a grant entry can authorize in this slice. Plan consent arrives with slice F;
// supersession is final once written, so a revocable grant cannot back it.
const ISSUABLE = { 'task.approve': ['approve'], 'decision.dispose': ['answer', 'cancel'] };
// Commands that may carry an envelope authority reference.
export const AUTHORITY_OPERATIONS = Object.freeze(['task.approve', 'task.restart', 'decision.dispose', 'answer']);

const projectOf = store => store.meta('project').projectId;
const requireLedger = (store, operation) => assert(authorityLedgerEnabled(store), `${operation} needs the migrated authority ledger (database schema 2); this project has not been migrated`);
const direct = ({ actor, onBehalfOf, authority }, operation) => {
  assert(actor === 'operator' && !onBehalfOf, `${operation} needs the operator directly; the orchestrator cannot issue or revoke operator authority, with or without an instruction`);
  assert(!authority, `${operation} cannot itself be authorized by a grant`);
};
const only = (p, keys, operation) => { const extra = Object.keys(p).filter(key => !keys.includes(key)); assert(!extra.length, `${operation} does not accept ${extra.join(', ')}; it accepts ${keys.join(', ')}`); };
const text = (value, label, max = 1000) => { assert(typeof value === 'string' && value.trim() && value.length <= max, `${label} is required (1-${max} characters)`); return value; };
const commandOf = (store, operation) => { assert(typeof store.commandId === 'string', `${operation} runs only as a recorded command`); return store.commandId; };

// The workflow digest a task approval binds: the selected catalog workflow, or the
// project's single workflow without a catalog.
export function approvalWorkflowDigest(store, task, binding = approvalBinding(store, task)) {
  return binding?.digest ?? store.meta('workflowDigest') ?? digest(store.meta('workflow'));
}
// The exact pins a task approval entry for this task needs right now (shown before issue).
export function approvalPins(store, task) {
  if (!authorityLedgerEnabled(store)) return undefined;
  try { return { taskId: task.id, taskRevision: task.revision, workflowDigest: approvalWorkflowDigest(store, task), operation: 'task.approve', disposition: 'approve' }; }
  catch (error) { return { unavailable: error.message }; }
}

// Validate one requested entry against current state. Entries are exact: the
// operator (or the console, from the snapshot) supplies every pin, and each must
// equal the current task revision, workflow, decision version, scope and options.
function checkEntry(store, e, index) {
  const where = `entry ${index + 1}${e?.entryId ? ` (${e.entryId})` : ''}`;
  assert(e && typeof e === 'object' && !Array.isArray(e), `${where} must be an object`);
  assert(ISSUABLE[e.operation], `${where}: operation ${e.operation} cannot be granted (grantable: ${Object.keys(ISSUABLE).join(', ')})`);
  assert(ISSUABLE[e.operation].includes(e.disposition), `${where}: ${e.operation} grants permit ${ISSUABLE[e.operation].join(' or ')}, not ${e.disposition}${e.disposition === 'supersede' ? '; supersession is final, so it needs the operator directly' : ''}`);
  const task = store.get('task', id(e.taskId, `${where} task id`));
  assert(task, `${where}: task ${e.taskId} does not exist`);
  assert(!['schedule', 'job'].includes(task.approvalKind) && !task.id.startsWith('job:'), `${where}: maintenance runs carry no grantable authority`);
  assert(e.taskRevision === task.revision, `${where}: task ${task.id} is at revision ${task.revision}, not ${e.taskRevision}; a grant pins the exact current revision`);
  assert(store.get('taskRevision', taskRevisionId(projectOf(store), task.id, task.revision)), `${where}: task ${task.id} revision ${task.revision} has no recorded snapshot`);
  if (e.operation === 'task.approve') {
    assert(!task.tracked, `${where}: tracked items cannot be approved`);
    const current = approvalWorkflowDigest(store, task);
    assert(e.workflowDigest === current, `${where}: task ${task.id} selects workflow ${current}, not ${e.workflowDigest}`);
    return;
  }
  const o = store.get('decisionObligation', id(e.obligationId, `${where} decision id`));
  assert(o && o.taskId === task.id, `${where}: decision ${e.obligationId} does not exist on task ${task.id}`);
  assert(o.status === 'unresolved', `${where}: decision ${o.id} is ${o.status}; a grant can only authorize settling an unresolved decision (confirming a settled one on a new revision needs the operator directly)`);
  assert(e.obligationVersion === o.version, `${where}: decision ${o.id} is at version ${o.version}, not ${e.obligationVersion}`);
  assert(o.applicability.length === 1 && o.applicability[0].revision === task.revision, `${where}: decision ${o.id} applies to ${o.applicability.length} task revisions; a grant pins exactly one, so this decision needs the operator directly`);
  assert(e.scopeDigest === o.scopeDigest && e.optionSetDigest === o.optionSetDigest, `${where}: scope or option-set digest does not match decision ${o.id}`);
  if (e.disposition === 'answer') {
    assert(Array.isArray(e.answers) && e.answers.length >= 1, `${where}: list the exact allowed answers`);
    for (const a of e.answers) assert(o.options.some(x => x.id === a?.optionId && x.payloadDigest === a?.payloadDigest), `${where}: answer ${a?.optionId} is not an exact option of decision ${o.id}`);
  }
}
// The exact cancellation payload digest a cancel entry pins, for a stated reason.
export const cancellationPayloadDigest = (decision, reason) => digest({ kind: 'cancel', payload: { scopeDigest: decision.scopeDigest, reason } });

// grant.issue: the operator, directly, issues exact entries to the orchestrator.
export function issueGrant(store, p, context) {
  requireLedger(store, 'grant.issue'); direct(context, 'grant.issue');
  only(p, ['grantId', 'notBefore', 'expiresAt', 'entries', 'reason'], 'grant.issue');
  const commandId = commandOf(store, 'grant.issue'), at = now();
  const grantId = p.grantId === undefined ? `grant-${digest({ projectId: projectOf(store), commandId }).slice(0, 24)}` : id(p.grantId, 'grant id');
  assert(!store.get('operatorGrant', grantId), `grant ${grantId} already exists; a changed scope needs a new grant`);
  const notBefore = p.notBefore ?? at;
  assert(typeof notBefore === 'string' && Number.isFinite(Date.parse(notBefore)), 'notBefore is an ISO date-time');
  assert(typeof p.expiresAt === 'string' && Number.isFinite(Date.parse(p.expiresAt)), 'expiresAt is required: an ISO date-time; grants never last indefinitely');
  assert(Date.parse(p.expiresAt) > Date.now(), 'expiresAt must be in the future');
  assert(Date.parse(p.expiresAt) > Date.parse(notBefore) && Date.parse(p.expiresAt) - Date.parse(notBefore) <= MAX_GRANT_MS, `a grant is valid for at most ${MAX_GRANT_MS / 86400000} days after notBefore`);
  assert(Array.isArray(p.entries) && p.entries.length >= 1 && p.entries.length <= 100, 'entries is a list of 1-100 exact entries');
  p.entries.forEach((e, index) => checkEntry(store, e, index));
  const entries = p.entries.map((e, index) => ({ ...e, entryId: e.entryId ?? `entry-${index + 1}`, maxUses: e.maxUses ?? 1 }));
  const grant = { schemaVersion: RECORD_SCHEMA_VERSION, id: grantId, projectId: projectOf(store), issuer: 'operator', issuedBy: { actor: 'operator', commandId }, grantee: 'orchestrator', notBefore: new Date(Date.parse(notBefore)).toISOString(), expiresAt: new Date(Date.parse(p.expiresAt)).toISOString(), entries, createdAt: at, version: 1, status: 'active', usage: {} };
  putAuthorityRecord(store, 'operatorGrant', grant);
  if (p.reason !== undefined) text(p.reason, 'reason', 1000);
  for (const taskId of new Set(entries.map(e => e.taskId))) assertTaskRecordsSound(store, taskId, 'grant.issue');
  store.event('grant.issued', { grantId, entries: entries.map(e => ({ entryId: e.entryId, operation: e.operation, disposition: e.disposition, taskId: e.taskId, taskRevision: e.taskRevision, ...(e.obligationId ? { decisionId: e.obligationId } : {}) })), notBefore: grant.notBefore, expiresAt: grant.expiresAt, ...(p.reason ? { reason: p.reason } : {}) });
  return grant;
}

// The in-transaction safeguard shared by grant commands and task approval: refused,
// and rolled back with everything the command wrote, if the task's decision-authority
// records would then fail the scoped audit.
export function assertTaskRecordsSound(store, taskId, operation) {
  const problems = auditAuthorityRecords(store, { taskId, limit: 5 });
  assert(!problems.length, `${operation} refused: it would leave decision-authority records of task ${taskId} that fail the audit: ${problems.map(x => `${x.kind} ${x.id}: ${x.reason}`).join('; ')}`);
}

// Why a grant cannot authorize anything now, or null while it is current.
export function grantLapse(grant, at = Date.now()) {
  if (!grant) return 'missing';
  if (grant.status === 'revoked') return `revoked${grant.revokedAt ? ` at ${grant.revokedAt}` : ''}`;
  if (at < Date.parse(grant.notBefore)) return `not valid before ${grant.notBefore}`;
  if (at >= Date.parse(grant.expiresAt)) return `expired at ${grant.expiresAt}`;
  return null;
}
// Whether an authority use still supports the approval or clearance it produced:
// a direct operator use until it is made inactive; a grant use also only while its
// grant is unrevoked and unexpired.
export function grantUseLapse(store, useId, at = Date.now()) {
  const use = useId ? store.get('authorityUse', useId) : null;
  if (!use) return `authority use ${useId} is missing`;
  if (use.status !== 'active') return `authority use ${use.id} is inactive (${use.inactiveReason})`;
  if (use.source !== 'grant') return null;
  const lapse = grantLapse(store.get('operatorGrant', use.grantId), at);
  return lapse ? `grant ${use.grantId} ${lapse}` : null;
}

// Consume one grant entry for the protected operation the current command performs.
// Called inside the application savepoint: if anything later in the command fails,
// the usage and the authority use roll back with it.
export function consumeGrant(store, { actor }, { operation, disposition, taskId, taskRevision, subject, check, derived }) {
  const context = store.commandAuthority, ref = context?.ref;
  assert(ref, `${operation} needs a stored operator grant reference`);
  assert(!context.used, 'one authority reference authorizes exactly one protected use per command');
  assert(actor === 'orchestrator', `a grant is issued to the orchestrator; the ${actor} acts directly and cites no grant`);
  const grant = store.get('operatorGrant', ref.grantId);
  assert(grant, `no operator grant ${ref.grantId}; only grants issued by the operator with grant.issue authorize work (job, schedule and integration grants do not)`);
  assert(grant.version === ref.expectedVersion, `grant ${grant.id} changed (version ${grant.version}, expected ${ref.expectedVersion}); read it again`);
  const lapse = grantLapse(grant);
  assert(!lapse, `grant ${grant.id} is ${lapse}`);
  const entry = grant.entries.find(e => e.entryId === ref.entryId);
  assert(entry, `grant ${grant.id} has no entry ${ref.entryId}`);
  assert(entry.operation === operation && entry.disposition === disposition, `grant entry ${grant.id}/${entry.entryId} permits ${entry.operation} (${entry.disposition}), not ${operation} (${disposition})`);
  assert(entry.taskId === taskId && entry.taskRevision === taskRevision, `grant entry ${grant.id}/${entry.entryId} pins task ${entry.taskId} revision ${entry.taskRevision}, not ${taskId} revision ${taskRevision}`);
  check(entry);
  const used = grant.usage[entry.entryId] ?? 0;
  assert(used < entry.maxUses, `grant entry ${grant.id}/${entry.entryId} is spent (${used} of ${entry.maxUses} use${entry.maxUses === 1 ? '' : 's'})`);
  const commandId = commandOf(store, operation), at = now();
  putAuthorityRecord(store, 'operatorGrant', { ...grant, version: grant.version + 1, usage: { ...grant.usage, [entry.entryId]: used + 1 } }, { expectedVersion: grant.version });
  const use = { schemaVersion: RECORD_SCHEMA_VERSION, id: digest({ kind: 'authorityUse', projectId: projectOf(store), commandId, grantId: grant.id, entryId: entry.entryId }), projectId: projectOf(store), source: 'grant', grantId: grant.id, entryId: entry.entryId, grantVersion: grant.version, commandId, operation, subjectDigest: authoritySubjectDigest(subject), disposition, consumptionKey: digest({ grantId: grant.id, entryId: entry.entryId, use: used + 1 }), derived, createdAt: at, status: 'active', version: 1 };
  context.used = true;
  store.event('grant.used', { grantId: grant.id, entryId: entry.entryId, operation, disposition, taskId, use: used + 1, maxUses: entry.maxUses, authorityUseId: use.id });
  return use;
}

// task.approve on a migrated project: the operator directly, or the orchestrator
// citing an exact approval entry. Operational delegation (policy.delegatedOperations)
// no longer approves a brief. Returns the authority use and the task's approval provenance.
export function approvalAuthority(store, task, binding, { actor, onBehalfOf }) {
  const workflowDigest = approvalWorkflowDigest(store, task, binding);
  const subject = approvalSubject({ taskId: task.id, taskRevision: task.revision, workflowDigest });
  const derived = [{ kind: 'taskApproval', id: task.id }];
  const commandId = commandOf(store, 'task.approve');
  if (store.commandAuthority?.ref && !store.commandAuthority.used) {
    const use = consumeGrant(store, { actor }, { operation: 'task.approve', disposition: 'approve', taskId: task.id, taskRevision: task.revision, subject, derived,
      check: entry => assert(entry.workflowDigest === workflowDigest, `grant entry ${entry.entryId} pins workflow ${entry.workflowDigest}, but task ${task.id} selects ${workflowDigest}`) });
    putAuthorityRecord(store, 'authorityUse', use);
    return { use, provenance: { source: 'grant', authorityUseId: use.id, grantId: use.grantId, entryId: use.entryId, workflowDigest } };
  }
  assert(actor === 'operator' && !onBehalfOf, 'task.approve by the orchestrator needs a stored operator grant covering this exact task revision and workflow (send authority: {grantId, entryId, expectedVersion}); operational delegation does not approve a brief on a migrated project');
  const use = { schemaVersion: RECORD_SCHEMA_VERSION, id: digest({ kind: 'authorityUse', projectId: projectOf(store), commandId, taskId: task.id, approvalVersion: task.approvalVersion + 1 }), projectId: projectOf(store), source: 'direct-operator', commandId, operation: 'task.approve', subjectDigest: authoritySubjectDigest(subject), disposition: 'approve', consumptionKey: digest({ commandId, operation: 'task.approve', taskId: task.id }), derived, createdAt: now(), status: 'active', version: 1 };
  putAuthorityRecord(store, 'authorityUse', use);
  return { use, provenance: { source: 'direct-operator', authorityUseId: use.id, workflowDigest } };
}
// Reasons the task's current approval cannot authorize work now (empty when it can, or
// when it predates the ledger: legacy approvals are inventoried by the migration).
export function approvalAuthorityReasons(store, task, at = Date.now()) {
  if (!authorityLedgerEnabled(store) || !task?.approvalAuthority || task.approvedRevision !== task.revision) return [];
  const lapse = grantUseLapse(store, task.approvalAuthority.authorityUseId, at);
  return lapse ? [`task ${task.id} approval is no longer valid: ${lapse}; the operator can approve it again, or issue a new grant`] : [];
}

function deactivateUse(store, use, reason) {
  if (use.status !== 'active') return;
  putAuthorityRecord(store, 'authorityUse', { ...use, inactiveReason: reason, inactiveAt: now(), status: 'inactive', version: use.version + 1 }, { expectedVersion: use.version });
}
// Revocation or expiry of a grant: every approval and clearance derived from it stops
// authorizing new effects. Approvals are withdrawn (flows stopped by revocation;
// expiry stops them at their next step); clearances become inactive and their
// decisions unresolved, so prepared intents fail the dispatch fence and a direct
// ratification or a new grant-backed disposition is needed. Effects already performed
// are not undone; a dispatched protected effect is recorded as an authority race.
export function invalidateGrantDerivations(store, grant, { reason, cause, hooks }) {
  const affected = { approvals: [], dispositions: [] };
  for (const use of store.all('authorityUse').filter(u => u.source === 'grant' && u.grantId === grant.id && u.status === 'active')) {
    if (use.operation === 'task.approve') {
      for (const task of store.all('task').filter(t => t.approvalAuthority?.authorityUseId === use.id && t.approvedRevision === t.revision)) {
        hooks.withdrawApproval(task, reason, cause === 'grant-revocation');
        affected.approvals.push(task.id);
      }
      deactivateUse(store, use, reason);
    } else if (use.operation === 'decision.dispose') {
      const d = store.all('decisionDisposition').find(x => x.authorityUseId === use.id);
      if (d?.status === 'active') { hooks.lapseDisposition(d, reason, cause); affected.dispositions.push(d.id); }
      else deactivateUse(store, use, reason);
    } else deactivateUse(store, use, reason);
  }
  for (const taskId of new Set([...affected.approvals, ...affected.dispositions.map(x => store.get('decisionObligation', store.get('decisionDisposition', x).obligationId).taskId)])) {
    bumpTaskAuthority(store, taskId, cause, grant.id);
    assertTaskRecordsSound(store, taskId, cause === 'grant-revocation' ? 'grant.revoke' : 'grant expiry');
  }
  return affected;
}

// grant.revoke: the operator, directly, ends a grant. Unused entries can no longer be
// used; derived approvals and clearances are invalidated going forward.
export function revokeGrant(store, p, context, hooks) {
  requireLedger(store, 'grant.revoke'); direct(context, 'grant.revoke');
  only(p, ['grantId', 'expectedVersion', 'reason'], 'grant.revoke');
  const commandId = commandOf(store, 'grant.revoke');
  const grant = store.need('operatorGrant', id(p.grantId, 'grant id'));
  assert(p.expectedVersion === grant.version, `grant ${grant.id} changed (version ${grant.version}, expected ${p.expectedVersion}); read it again`);
  assert(grant.status === 'active', `grant ${grant.id} is already revoked`);
  const reason = text(p.reason, 'revocation reason', 1000);
  putAuthorityRecord(store, 'operatorGrant', { ...grant, version: grant.version + 1, status: 'revoked', revokedAt: now(), revocationCommandId: commandId, revocationReason: reason }, { expectedVersion: grant.version });
  const affected = invalidateGrantDerivations(store, grant, { reason: `grant ${grant.id} revoked by the operator: ${reason}`, cause: 'grant-revocation', hooks });
  // Every task the grant names is audited, used or not: the grant row is in each one's scope.
  for (const taskId of new Set(grant.entries.map(e => e.taskId))) if (store.get('task', taskId)) assertTaskRecordsSound(store, taskId, 'grant.revoke');
  store.event('grant.revoked', { grantId: grant.id, reason, ...affected });
  return { grant: store.need('operatorGrant', grant.id), ...affected };
}

// Expired grants with derivations still active: make the lapse explicit (run by the
// engine each tick, and by decision commands before they read a decision).
export function expireGrants(store, hooks, at = Date.now()) {
  if (!authorityLedgerEnabled(store)) return [];
  const expired = [];
  for (const grant of store.all('operatorGrant').filter(g => g.status === 'active' && at >= Date.parse(g.expiresAt))) {
    if (!store.all('authorityUse').some(u => u.source === 'grant' && u.grantId === grant.id && u.status === 'active')) continue;
    const affected = invalidateGrantDerivations(store, grant, { reason: `grant ${grant.id} expired at ${grant.expiresAt}`, cause: 'grant-expiry', hooks });
    store.event('grant.expired', { grantId: grant.id, expiresAt: grant.expiresAt, ...affected });
    expired.push(grant.id);
  }
  return expired;
}

// Read projection for the service collection, snapshot and console.
export function grantView(store, grant, at = Date.now()) {
  const uses = store.all('authorityUse').filter(u => u.source === 'grant' && u.grantId === grant.id);
  return { ...grant, current: !grantLapse(grant, at), lapse: grantLapse(grant, at),
    entries: grant.entries.map(e => ({ ...e, used: grant.usage[e.entryId] ?? 0, remaining: Math.max(0, e.maxUses - (grant.usage[e.entryId] ?? 0)) })),
    uses: uses.map(({ id: useId, entryId, operation, disposition, commandId, createdAt, status, inactiveReason }) => ({ id: useId, entryId, operation, disposition, commandId, createdAt, status, inactiveReason })) };
}
export const grantViews = (store, { limit = 50 } = {}) => authorityLedgerEnabled(store) ? store.all('operatorGrant').slice(-limit).map(g => grantView(store, g)) : [];

// The envelope authority reference: exactly {grantId, entryId, expectedVersion}.
export function validateAuthorityReference(authority, { operation, ledger }) {
  if (authority === undefined) return;
  assert(ledger, 'authority references need the migrated authority ledger (database schema 2); this project has not been migrated');
  assert(authority && typeof authority === 'object' && !Array.isArray(authority) && Object.keys(authority).every(k => ['grantId', 'entryId', 'expectedVersion'].includes(k)), 'authority is {grantId, entryId, expectedVersion}');
  id(authority.grantId, 'authority grant id'); id(authority.entryId, 'authority entry id');
  assert(Number.isSafeInteger(authority.expectedVersion) && authority.expectedVersion >= 1, 'authority.expectedVersion is the grant version you read');
  assert(AUTHORITY_OPERATIONS.includes(operation), `${operation} cannot use grant authority; grants authorize ${AUTHORITY_OPERATIONS.join(', ')}`);
}
