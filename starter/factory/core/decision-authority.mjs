// Durable decision and operator-authority records (plans 7/8, slice A).
//
// This module is the record contract only: strict validators, immutable and
// compare-and-swap writes, immutable task revision snapshots, the per-task
// authority revision, reference audit and retention roots. It wires no
// enforcement: nothing here approves, answers, issues or consumes authority,
// and no caller reads these records to allow or refuse work yet. Callers own
// the transaction.
//
// The ledger exists only in a database at AUTHORITY_SCHEMA_VERSION, which a
// project reaches through the explicit offline migration in
// operations/authority-migration.mjs. A schema-1 database is left untouched.
import { assert, canonical, digest, now } from './contracts.mjs';

export const AUTHORITY_SCHEMA_VERSION = 2;
export const RECORD_SCHEMA_VERSION = 1;
export const authorityLedgerEnabled = store => store.meta('schemaVersion') === AUTHORITY_SCHEMA_VERSION;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const BOUNDARIES = ['build', 'merge', 'complete', 'release'];
const ORIGINS = ['operator', 'incident', 'schedule', 'review', 'other'];

// A tiny closed schema language. Every object is closed: unknown keys are refused.
const id = { t: 'id' }, hex = { t: 'digest' }, time = { t: 'time' }, bool = { t: 'bool' };
const text = (max, min = 1) => ({ t: 'text', max, min });
const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ t: 'int', min, max });
const oneOf = (...values) => ({ t: 'enum', values });
const list = (of, max, min = 0) => ({ t: 'list', of, max, min });
const obj = (fields, optional = {}) => ({ t: 'object', fields, optional });
const nullable = spec => ({ t: 'nullable', spec });
const json = maxBytes => ({ t: 'json', maxBytes });
const map = (key, value, max) => ({ t: 'map', key, value, max });
function check(spec, value, path) {
  const fail = why => { throw new Error(`invalid ${path}: ${why}`); };
  switch (spec.t) {
    case 'id': if (typeof value !== 'string' || !ID.test(value)) fail('expected an identifier'); return;
    case 'digest': if (typeof value !== 'string' || !DIGEST.test(value)) fail('expected a sha-256 digest'); return;
    case 'time': if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail('expected an ISO date-time'); return;
    case 'bool': if (typeof value !== 'boolean') fail('expected true or false'); return;
    case 'text': if (typeof value !== 'string' || value.length < spec.min || value.length > spec.max || (spec.min > 0 && !value.trim())) fail(`expected text of ${spec.min}-${spec.max} characters`); return;
    case 'int': if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) fail(`expected a whole number from ${spec.min} to ${spec.max}`); return;
    case 'enum': if (!spec.values.includes(value)) fail(`expected one of ${spec.values.join(', ')}`); return;
    case 'nullable': if (value !== null) check(spec.spec, value, path); return;
    case 'list':
      if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) fail(`expected a list of ${spec.min}-${spec.max} entries`);
      value.forEach((item, index) => check(spec.of, item, `${path}[${index}]`)); return;
    case 'map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
      const entries = Object.entries(value); if (entries.length > spec.max) fail(`expected at most ${spec.max} entries`);
      for (const [key, item] of entries) { check(spec.key, key, `${path} key`); check(spec.value, item, `${path}.${key}`); } return;
    }
    case 'json': {
      let size; try { size = Buffer.byteLength(canonical(value)); } catch { fail('expected JSON data'); }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
      if (size > spec.maxBytes) fail(`larger than ${spec.maxBytes} bytes`); return;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('expected an object');
      for (const key of Object.keys(value)) if (!Object.hasOwn(spec.fields, key) && !Object.hasOwn(spec.optional, key)) fail(`unknown field ${key}`);
      for (const [key, field] of Object.entries(spec.fields)) { if (!Object.hasOwn(value, key) || value[key] === undefined) fail(`missing ${key}`); check(field, value[key], `${path}.${key}`); }
      for (const [key, field] of Object.entries(spec.optional)) if (Object.hasOwn(value, key)) { if (value[key] === undefined) fail(`undefined ${key}`); check(field, value[key], `${path}.${key}`); }
      return;
    }
    default: throw new Error(`unknown schema type ${spec.t}`);
  }
}
const head = { schemaVersion: oneOf(RECORD_SCHEMA_VERSION), projectId: id };
const unique = (values, label) => assert(new Set(values).size === values.length, `duplicate ${label}`);
const inactive = { inactiveReason: text(1000), inactiveAt: time };

// Immutable task revision snapshot. The first migration records only the
// current revision with historyIncomplete; earlier content is never invented.
const REQUEST_REF = obj({ field: oneOf('originalRequest'), origin: oneOf(...ORIGINS), source: text(500), date: text(40), digest: hex, verbatim: bool });
const TASK_REVISION = obj({ ...head, id: hex, taskId: id, revision: hex, brief: json(256 * 1024), briefDigest: hex, requestRefs: list(REQUEST_REF, 1), requestCoverage: oneOf('recorded', 'unknown'), previousRevision: nullable(hex), recordedBy: oneOf('task.put', 'recurring', 'migration', 'finding', 'upkeep'), createdAt: time }, { historyIncomplete: oneOf(true) });
const TASK_AUTHORITY = obj({ ...head, id, taskId: id, authorityRevision: int(1), updatedAt: time, lastChange: obj({ cause: oneOf('migration', 'task-revision', 'decision-open', 'decision-carry-forward', 'decision-disposition', 'decision-revocation', 'grant-revocation', 'grant-expiry') }, { ref: text(200) }) });
const SCOPE = obj({ taskId: id, choiceId: id }, { featureId: id, paths: list(text(500), 32, 1) });
const OPTION = obj({ id, label: text(500), payloadDigest: hex });
const APPLICABILITY = obj({ taskId: id, revision: hex, state: oneOf('pending', 'requires-confirmation', 'covered') }, { dispositionId: id });
const DECISION_OBLIGATION = obj({ ...head, id, taskId: id, originRevision: hex, version: int(1), owner: oneOf('operator'), source: obj({ kind: oneOf('operator', 'orchestrator', 'worker-report', 'migration') }, { ref: text(500), flowId: id, attemptId: id, candidateDigest: hex }), question: text(4000), scope: SCOPE, scopeDigest: hex, options: list(OPTION, 16, 1), optionSetDigest: hex, requiredAt: list(oneOf(...BOUNDARIES), 4, 2), applicability: list(APPLICABILITY, 64, 1), status: oneOf('unresolved', 'resolved', 'canceled', 'superseded'), activeDispositionId: nullable(id), createdAt: time, updatedAt: time }, { rationale: text(4000), supersededBy: list(id, 16, 1), reopens: id });
const DECISION_DISPOSITION = obj({ ...head, id, obligationId: id, obligationVersion: int(1), applicability: list(obj({ taskId: id, revision: hex }), 64, 1), scopeDigest: hex, optionSetDigest: hex, kind: oneOf('answer', 'cancel', 'supersede'), rationale: text(4000), authorityUseId: id, commandId: id, createdAt: time, status: oneOf('active', 'inactive'), version: int(1) }, { answer: obj({ optionId: id, payloadDigest: hex }), cancellation: obj({ scopeDigest: hex, reason: text(4000) }), supersession: obj({ replacements: list(id, 16) }, { removedScope: text(4000), revisedRevision: hex }), evidence: list(text(500), 16, 1), ratifiesDispositionId: id, relayedAnswerId: id, ...inactive });
const GRANT_ENTRY = obj({ entryId: id, taskId: id, taskRevision: hex, operation: oneOf('task.approve', 'decision.dispose', 'plan.consent'), disposition: oneOf('approve', 'answer', 'cancel', 'supersede', 'consent'), maxUses: int(1, 100) }, { workflowDigest: hex, obligationId: id, obligationVersion: int(1), scopeDigest: hex, optionSetDigest: hex, answers: list(obj({ optionId: id, payloadDigest: hex }), 16, 1), payloadDigest: hex, planDigest: hex, contextDigest: hex, baseDigest: hex });
const OPERATOR_GRANT = obj({ ...head, id, issuer: oneOf('operator'), issuedBy: obj({ actor: oneOf('operator'), commandId: id }), grantee: oneOf('orchestrator'), notBefore: time, expiresAt: time, entries: list(GRANT_ENTRY, 100, 1), createdAt: time, version: int(1), status: oneOf('active', 'revoked'), usage: map(id, int(0, 100), 100) }, { revokedAt: time, revocationCommandId: id, revocationReason: text(1000) });
const AUTHORITY_USE = obj({ ...head, id, source: oneOf('grant', 'direct-operator'), commandId: id, operation: oneOf('task.approve', 'decision.dispose', 'decision.ratify', 'plan.consent', 'release.review'), subjectDigest: hex, disposition: oneOf('approve', 'answer', 'cancel', 'supersede', 'consent', 'review', 'ratify'), consumptionKey: hex, derived: list(obj({ kind: text(64), id }), 16), createdAt: time, status: oneOf('active', 'inactive'), version: int(1) }, { grantId: id, entryId: id, grantVersion: int(1), ...inactive });
const CHOICE = obj({ localId: id, title: text(500), behavior: text(4000), rationale: text(4000), scope: text(1000), owner: oneOf('operator', 'conflict', 'collected', 'unclear') }, { options: list(text(500), 16, 1), relation: text(1000), conflicts: list(text(1000), 16, 1), obligationId: id });
const DECISION_REPORT = obj({ ...head, id, taskId: id, taskRevision: hex, reportVersion: int(1), previousReportId: nullable(id), producer: obj({}, { flowId: id, attemptId: id, step: id, model: text(200) }), choices: list(CHOICE, 64), completeness: oneOf('declared', 'unknown'), reportSchemaVersion: int(1, 1000), bodyDigest: hex, createdAt: time }, { candidateDigest: hex, planDigest: hex });
const MANIFEST = obj({ repository: text(500), target: text(200), candidateDigest: hex, included: list(obj({ taskId: id, revision: hex }, { featureId: id }), 256, 1), reports: list(obj({ reportId: id, reportVersion: int(1), bodyDigest: hex }), 256) });
const RELEASE_REVIEW = obj({ ...head, id, manifest: MANIFEST, manifestDigest: hex, reportSetDigest: hex, dispositions: list(obj({ reportId: id, choiceId: id, disposition: oneOf('accept', 'require-change', 'not-applicable'), rationale: text(2000) }), 1024), authorityUseId: id, commandId: id, createdAt: time, status: oneOf('active', 'revoked'), version: int(1) }, { revokedAt: time, revocationReason: text(1000) });
// An answer a non-operator actor entered on the operator's behalf (slice C): who
// relayed it (the command's actor, never a payload field), the operator's words
// verbatim, the channel they came from, and the option the relayer mapped them to.
// `selected` is that mapping: the relayer's interpretation, never the operator's words.
// It takes effect only through a direct operator confirmation or an exact grant. Every
// grant-backed answer carries one, so who entered it and what was said are kept.
// It never settles a decision on its own: it is applied only through a stored grant
// covering that exact answer, or confirmed by a direct operator disposition that cites it.
const RELAYED_ANSWER = obj({ ...head, id, decisionId: id, decisionVersion: int(1), taskId: id, taskRevision: hex, scopeDigest: hex, optionSetDigest: hex, selected: obj({ optionId: id, payloadDigest: hex }), relayedBy: oneOf('orchestrator'), quote: text(4000), channel: text(200), commandId: id, createdAt: time, status: oneOf('pending', 'applied', 'confirmed', 'superseded'), version: int(1) }, { inboxId: text(300), dispositionId: id, resolvedAt: time, resolvedReason: text(1000) });
// Migration inventory: what the explicit migration found and how it classified it.
const LEGACY_AUTHORITY = obj({ ...head, id: hex, migrationId: hex, item: oneOf('task-approval', 'open-question', 'carried-over-flow', 'release-integration'), subject: obj({}, { taskId: id, revision: hex, approvalVersion: int(0), inboxId: text(300), flowId: text(300), integration: id }), classification: oneOf('direct-operator', 'configured', 'legacy-delegated', 'legacy-unverified', 'informational-v1', 'ambiguous-question', 'unqualified-release'), status: oneOf('retained', 'held'), reasons: list(text(500), 8, 1), version: int(1), createdAt: time }, { evidence: obj({}, { commandId: id, operation: text(64), actor: oneOf('operator', 'orchestrator'), onBehalfOf: bool, eventSequence: int(1), approvalKind: text(64) }), resolution: obj({ commandId: id, kind: text(64), at: time }) });

// The migration record (meta authorityMigration) and its hold (meta authorityHold).
// Closed like every record: a marker reduced to {toSchema: 2}, or one with extra
// fields, is structural corruption and the database refuses to open.
const MIGRATION_RECORD = obj({ schemaVersion: oneOf(RECORD_SCHEMA_VERSION), migrationId: hex, fromSchema: oneOf(1), toSchema: oneOf(AUTHORITY_SCHEMA_VERSION), migratedAt: time, inventoryDigest: hex, counts: obj({ snapshots: int(0), requestUnknown: int(0), retained: int(0), held: int(0) }), coverage: oneOf('incomplete'), backup: obj({ path: text(4096), files: int(1) }), creates: obj({ grants: oneOf(0), authorityUses: oneOf(0), dispositions: oneOf(0) }) });
const AUTHORITY_HOLD = obj({ migrationId: hex, since: time, reasons: list(text(500), 8, 1) });
export const migrationIdOf = (projectId, inventoryDigest) => digest({ kind: 'authorityMigration', projectId, inventoryDigest });
export const legacyAuthorityId = (projectId, item, subject) => digest({ kind: 'legacyAuthority', projectId, item, subject });
// What the migration classified each item as, before any later resolution.
export const legacyInitialStatus = classification => ['direct-operator', 'configured'].includes(classification) ? 'retained' : 'held';
// The inventory digest the migration record names, over the snapshot and
// inventory facts it wrote. Snapshots are ordered by task id and items by id, so
// it can be recomputed from the stored rows (a VACUUM copy may renumber rows).
export function migrationInventoryDigest(projectId, snapshots, items) {
  const bySnapshot = [...snapshots].map(({ taskId, revision, briefDigest }) => ({ taskId, revision, briefDigest })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  const byId = [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return digest({ projectId, from: 1, to: AUTHORITY_SCHEMA_VERSION, snapshots: bySnapshot, items: byId });
}
// Opening a schema-2 database validates its migration record and hold: closed
// shape, derived identity, internally consistent counts. Inventory linkage to the
// stored rows is checked by auditAuthorityRecords (restore, retention, migration).
export function validateMigrationMarker(store) {
  const marker = store.meta('authorityMigration'), projectId = store.meta('project')?.projectId;
  try {
    check(MIGRATION_RECORD, marker, 'authorityMigration');
    assert(marker.migrationId === migrationIdOf(projectId, marker.inventoryDigest), 'migration id is not derived from this project and its inventory');
    assert(marker.counts.requestUnknown <= marker.counts.snapshots, 'more unknown-request snapshots than snapshots');
    const hold = store.meta('authorityHold', null);
    if (hold !== null) { check(AUTHORITY_HOLD, hold, 'authorityHold'); assert(hold.migrationId === marker.migrationId, 'authority hold names another migration'); }
  } catch (error) { throw new Error(`database schema 2 with a corrupt authority migration record (${error.message}); restore the pre-migration backup`); }
  return marker;
}

// kind: schema, serialized bound, and the mutable projection keys of a versioned record.
// Kinds without a projection are immutable once written. versionKey names the
// compare-and-swap counter when it is not `version`.
export const AUTHORITY_RECORDS = Object.freeze({
  taskRevision: { schema: TASK_REVISION, maxBytes: 300 * 1024, projection: null },
  taskAuthority: { schema: TASK_AUTHORITY, maxBytes: 4 * 1024, projection: ['authorityRevision', 'updatedAt', 'lastChange'], versionKey: 'authorityRevision' },
  decisionObligation: { schema: DECISION_OBLIGATION, maxBytes: 64 * 1024, projection: ['version', 'applicability', 'status', 'activeDispositionId', 'supersededBy', 'updatedAt'] },
  decisionDisposition: { schema: DECISION_DISPOSITION, maxBytes: 32 * 1024, projection: ['version', 'status', 'inactiveReason', 'inactiveAt'] },
  operatorGrant: { schema: OPERATOR_GRANT, maxBytes: 40 * 1024, payloadBytes: 32 * 1024, projection: ['version', 'status', 'usage', 'revokedAt', 'revocationCommandId', 'revocationReason'] },
  authorityUse: { schema: AUTHORITY_USE, maxBytes: 8 * 1024, projection: ['version', 'status', 'inactiveReason', 'inactiveAt'] },
  decisionReport: { schema: DECISION_REPORT, maxBytes: 256 * 1024, projection: null },
  releaseReview: { schema: RELEASE_REVIEW, maxBytes: 256 * 1024, projection: ['version', 'status', 'revokedAt', 'revocationReason'] },
  legacyAuthority: { schema: LEGACY_AUTHORITY, maxBytes: 8 * 1024, projection: ['version', 'status', 'resolution'] },
  relayedAnswer: { schema: RELAYED_ANSWER, maxBytes: 12 * 1024, projection: ['version', 'status', 'dispositionId', 'resolvedAt', 'resolvedReason'] },
});
export const AUTHORITY_KINDS = Object.freeze(Object.keys(AUTHORITY_RECORDS));

export const taskRevisionId = (projectId, taskId, revision) => digest({ kind: 'taskRevision', projectId, taskId, revision });
const optionSet = options => options.map(({ id: optionId, payloadDigest }) => ({ id: optionId, payloadDigest }));
export const optionSetDigest = options => digest(optionSet(options));
export const scopeDigest = scope => digest(scope);
export const reportBodyDigest = report => digest({ taskId: report.taskId, taskRevision: report.taskRevision, reportVersion: report.reportVersion, previousReportId: report.previousReportId, producer: report.producer, choices: report.choices, completeness: report.completeness, reportSchemaVersion: report.reportSchemaVersion, candidateDigest: report.candidateDigest ?? null, planDigest: report.planDigest ?? null });
const immutablePart = (kind, record) => {
  const projection = AUTHORITY_RECORDS[kind].projection;
  if (!Array.isArray(projection)) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !projection.includes(key)));
};

// The dispositions an authority use may permit for its operation.
const USE_DISPOSITIONS = { 'task.approve': ['approve'], 'decision.dispose': ['answer', 'cancel', 'supersede'], 'decision.ratify': ['ratify'], 'plan.consent': ['consent'], 'release.review': ['review'] };
// Record-local rules beyond the field schema: digests that must match their
// content, exact cross-field shapes, and lifecycle states that must agree.
const RULES = {
  taskRevision(r) {
    assert(r.brief.id === r.taskId, 'taskRevision brief belongs to another task');
    assert(r.briefDigest === digest(r.brief), 'taskRevision brief digest mismatch');
    assert(r.id === taskRevisionId(r.projectId, r.taskId, r.revision), 'taskRevision id must be derived from project, task and revision');
    assert(r.requestCoverage === (r.requestRefs.length ? 'recorded' : 'unknown'), 'taskRevision request coverage disagrees with its references');
    assert(r.previousRevision !== r.revision, 'taskRevision cannot precede itself');
    if (r.recordedBy === 'migration') assert(r.historyIncomplete === true && r.previousRevision === null, 'a migrated revision has no reconstructed history');
  },
  taskAuthority(r) { assert(r.id === r.taskId, 'taskAuthority id is its task id'); },
  decisionObligation(r) {
    assert(r.scope.taskId === r.taskId, 'decision scope belongs to another task');
    assert(r.scopeDigest === scopeDigest(r.scope), 'decision scope digest mismatch');
    unique(r.options.map(o => o.id), 'decision option id'); assert(r.optionSetDigest === optionSetDigest(r.options), 'decision option-set digest mismatch');
    unique(r.requiredAt, 'decision boundary'); assert(['merge', 'complete'].every(b => r.requiredAt.includes(b)), 'an operator-owned decision always holds merge and complete');
    unique(r.applicability.map(a => `${a.taskId}@${a.revision}`), 'decision applicability');
    assert(r.applicability.some(a => a.taskId === r.taskId && a.revision === r.originRevision), 'decision applicability must retain its origin revision');
    for (const a of r.applicability) assert(a.state === 'covered' ? a.dispositionId === r.activeDispositionId && r.activeDispositionId !== null : a.dispositionId === undefined, 'decision applicability coverage must name the active disposition');
    if (r.status === 'unresolved') assert(r.activeDispositionId === null, 'an unresolved decision has no active disposition');
    else assert(r.activeDispositionId !== null, `a ${r.status} decision names its disposition`);
    assert(r.reopens !== r.id, 'a decision cannot reopen itself');
    if (r.supersededBy) { unique(r.supersededBy, 'replacement decision'); assert(!r.supersededBy.includes(r.id), 'a decision cannot supersede itself'); assert(r.status === 'superseded', 'only a superseded decision names replacements'); }
  },
  decisionDisposition(r) {
    const shapes = { answer: 'answer', cancel: 'cancellation', supersede: 'supersession' };
    for (const [kind, key] of Object.entries(shapes)) assert((r.kind === kind) === Object.hasOwn(r, key), `a ${r.kind} disposition carries exactly its ${shapes[r.kind]} payload`);
    assert(!Object.hasOwn(r, 'ratifiesDispositionId') || r.kind === 'answer' && r.ratifiesDispositionId !== r.id, 'only an answer can ratify, and only another disposition');
    if (r.kind === 'supersede') {
      const s = r.supersession; assert(!s.replacements.includes(r.obligationId), 'a decision cannot supersede itself');
      unique(s.replacements, 'replacement decision');
      assert(s.replacements.length > 0 || (s.removedScope && s.revisedRevision), 'supersession needs replacement decisions or an authorized scope removal tied to a revised brief');
    }
    if (r.kind === 'cancel') assert(r.cancellation.scopeDigest === r.scopeDigest, 'cancellation must name the exact decision scope');
    unique(r.applicability.map(a => `${a.taskId}@${a.revision}`), 'disposition applicability');
    assert((r.status === 'inactive') === (Object.hasOwn(r, 'inactiveReason') && Object.hasOwn(r, 'inactiveAt')), 'an inactive disposition records why and when');
  },
  operatorGrant(r) {
    assert(Date.parse(r.expiresAt) > Date.parse(r.notBefore), 'grant must expire after it starts');
    unique(r.entries.map(e => e.entryId), 'grant entry id');
    for (const e of r.entries) {
      const has = keys => keys.every(k => Object.hasOwn(e, k)), none = keys => keys.every(k => !Object.hasOwn(e, k));
      const decision = ['obligationId', 'obligationVersion', 'scopeDigest', 'optionSetDigest', 'answers', 'payloadDigest'], plan = ['planDigest', 'contextDigest', 'baseDigest'];
      if (e.operation === 'task.approve') assert(e.disposition === 'approve' && has(['workflowDigest']) && none([...decision, ...plan]), `grant entry ${e.entryId}: task approval pins exactly a task revision and workflow`);
      if (e.operation === 'plan.consent') assert(e.disposition === 'consent' && has(['workflowDigest', ...plan]) && none(decision), `grant entry ${e.entryId}: plan consent pins plan, context, base and workflow`);
      if (e.operation === 'decision.dispose') {
        assert(['answer', 'cancel', 'supersede'].includes(e.disposition) && has(['obligationId', 'obligationVersion', 'scopeDigest', 'optionSetDigest']) && none(['workflowDigest', ...plan]), `grant entry ${e.entryId}: a decision disposition pins the decision version, scope and options`);
        if (e.disposition === 'answer') { assert(has(['answers']) && none(['payloadDigest']), `grant entry ${e.entryId}: an answer grant lists the exact allowed answers`); unique(e.answers.map(a => a.optionId), 'granted answer'); }
        else assert(has(['payloadDigest']) && none(['answers']), `grant entry ${e.entryId}: cancel or supersede pins its exact payload`);
      }
    }
    for (const [entryId, used] of Object.entries(r.usage)) { const entry = r.entries.find(e => e.entryId === entryId); assert(entry, `grant usage names unknown entry ${entryId}`); assert(used <= entry.maxUses, `grant entry ${entryId} used beyond its limit`); }
    assert((r.status === 'revoked') === (Object.hasOwn(r, 'revokedAt') && Object.hasOwn(r, 'revocationCommandId')), 'a revoked grant records when and by which command');
    assert(Buffer.byteLength(canonical(immutablePart('operatorGrant', r))) <= AUTHORITY_RECORDS.operatorGrant.payloadBytes, 'grant authority payload larger than 32768 bytes');
  },
  authorityUse(r) {
    const grantFields = ['grantId', 'entryId', 'grantVersion'];
    assert(r.source === 'grant' ? grantFields.every(k => Object.hasOwn(r, k)) : grantFields.every(k => !Object.hasOwn(r, k)), 'a grant use names its grant entry; a direct operator use names none');
    assert(USE_DISPOSITIONS[r.operation].includes(r.disposition), `an authority use for ${r.operation} cannot permit ${r.disposition}`);
    assert(r.operation !== 'decision.ratify' || r.source === 'direct-operator', 'ratification is direct operator authority only; it is never granted');
    assert((r.status === 'inactive') === (Object.hasOwn(r, 'inactiveReason') && Object.hasOwn(r, 'inactiveAt')), 'an inactive authority use records why and when');
  },
  decisionReport(r) {
    unique(r.choices.map(c => c.localId), 'report choice id');
    assert(r.previousReportId !== r.id, 'a report cannot precede itself');
    assert(r.bodyDigest === reportBodyDigest(r), 'report body digest mismatch');
  },
  releaseReview(r) {
    assert(r.manifestDigest === digest(r.manifest), 'release manifest digest mismatch');
    assert(r.reportSetDigest === digest(r.manifest.reports), 'release report-set digest mismatch');
    unique(r.manifest.included.map(i => `${i.taskId}@${i.revision}`), 'released task revision');
    unique(r.manifest.reports.map(x => x.reportId), 'released report');
    unique(r.dispositions.map(d => `${d.reportId}/${d.choiceId}`), 'reviewed choice');
    for (const d of r.dispositions) assert(r.manifest.reports.some(x => x.reportId === d.reportId), `review names report ${d.reportId} outside its manifest`);
    assert((r.status === 'revoked') === Object.hasOwn(r, 'revokedAt'), 'a revoked review records when');
  },
  relayedAnswer(r) {
    assert(['applied', 'confirmed'].includes(r.status) === Object.hasOwn(r, 'dispositionId'), 'an applied or confirmed relayed answer names the disposition that settled it; a pending or superseded one names none');
    assert((r.status === 'superseded') === Object.hasOwn(r, 'resolvedReason'), 'a superseded relayed answer records why');
  },
  legacyAuthority(r) {
    assert(r.id === legacyAuthorityId(r.projectId, r.item, r.subject), 'legacyAuthority id must be derived from project, item and subject');
    assert(!(r.status === 'retained' && ['legacy-delegated', 'legacy-unverified', 'ambiguous-question', 'unqualified-release'].includes(r.classification) && !r.resolution), 'ambiguous legacy authority stays held until explicitly resolved');
    if (!r.resolution) assert(r.status === legacyInitialStatus(r.classification), 'unresolved legacy authority keeps the status its classification gave it');
  },
};

// Transition rules for versioned records, checked against the stored previous
// version. Compare-and-swap alone would let a caller replace the projection
// wholesale; these keep the lifecycle one-way: usage never decreases or
// disappears, revocation and inactivation are final (inactive evidence is
// replaced by a new record from ratification or a fresh answer, never
// reactivated in place), applicability is never dropped, and a settled decision
// changes its disposition only by returning to unresolved.
const TRANSITIONS = {
  taskAuthority() {},
  decisionObligation(prev, next, store) {
    assert(prev.status !== 'superseded', 'a superseded decision is final; its replacements carry the hold');
    for (const a of prev.applicability) assert(next.applicability.some(b => b.taskId === a.taskId && b.revision === a.revision), `decision applicability ${a.taskId}@${a.revision} cannot be dropped`);
    if (prev.status !== 'unresolved' && next.status !== 'unresolved') assert(next.status === prev.status && next.activeDispositionId === prev.activeDispositionId, 'a settled decision changes its disposition only by revocation back to unresolved');
    if (next.activeDispositionId !== null && next.activeDispositionId !== prev.activeDispositionId) {
      const d = store.get('decisionDisposition', next.activeDispositionId);
      assert(d && d.obligationId === next.id && d.status === 'active', `decision ${next.id} can only name an active disposition of its own`);
    }
  },
  decisionDisposition(prev, next) { assert(prev.status === 'active' && next.status === 'inactive', 'a disposition can only become inactive; inactive evidence is never reactivated in place: ratify or answer anew'); },
  authorityUse(prev, next) { assert(prev.status === 'active' && next.status === 'inactive', 'an authority use can only become inactive; inactive evidence is never reactivated in place'); },
  operatorGrant(prev, next) {
    assert(prev.status === 'active', 'a revoked grant is final');
    for (const [entryId, used] of Object.entries(prev.usage)) assert(Object.hasOwn(next.usage, entryId) && next.usage[entryId] >= used, `grant usage of entry ${entryId} can only increase`);
    if (next.status === 'revoked') assert(canonical(next.usage) === canonical(prev.usage), 'revoking a grant consumes nothing');
  },
  releaseReview(prev, next) { assert(prev.status === 'active' && next.status === 'revoked', 'a release review can only be revoked; a revoked review is final'); },
  relayedAnswer(prev, next) { assert(prev.status === 'pending' && ['confirmed', 'superseded'].includes(next.status), 'a relayed answer is resolved once, from pending to confirmed or superseded'); },
  legacyAuthority(prev, next) {
    assert(!prev.resolution, 'resolved legacy authority is final');
    assert(next.resolution && (next.status === prev.status || (prev.status === 'held' && next.status === 'retained')), 'legacy authority changes only by recording its resolution');
  },
};

export function validateAuthorityRecord(kind, record, { projectId } = {}) {
  const definition = AUTHORITY_RECORDS[kind]; assert(definition, `unknown authority record kind ${kind}`);
  let size; try { size = Buffer.byteLength(canonical(record)); } catch { throw new Error(`invalid ${kind}: expected JSON data`); }
  assert(size <= definition.maxBytes, `${kind} record larger than ${definition.maxBytes} bytes`);
  check(definition.schema, record, kind);
  RULES[kind](record);
  if (projectId !== undefined) assert(record.projectId === projectId, `${kind} belongs to another project`);
  return record;
}

const projectOf = store => store.meta('project').projectId;
const requireLedger = store => assert(authorityLedgerEnabled(store), 'decision-authority records need the migrated database schema; run the authority migration first');
// Write one authority record inside the caller's transaction. A record without
// a projection is immutable: rewriting it identically is a no-op and any change
// is refused. A versioned record changes only its projection, by exactly one
// version, under the caller's expected version.
export function putAuthorityRecord(store, kind, record, { expectedVersion } = {}) {
  requireLedger(store);
  validateAuthorityRecord(kind, record, { projectId: projectOf(store) });
  const definition = AUTHORITY_RECORDS[kind], existing = store.get(kind, record.id), v = definition.versionKey ?? 'version';
  if (!existing) {
    if (Array.isArray(definition.projection)) assert(record[v] === 1 && (expectedVersion === undefined || expectedVersion === 0), `a new ${kind} starts at version 1`);
    return store.put(kind, record);
  }
  if (!Array.isArray(definition.projection)) {
    assert(canonical(existing) === canonical(record), `${kind} ${record.id} is immutable`);
    return existing;
  }
  assert(Number.isSafeInteger(expectedVersion) && existing[v] === expectedVersion, `${kind} ${record.id} changed; expected version ${expectedVersion}, found ${existing[v]}`);
  assert(record[v] === existing[v] + 1, `${kind} ${record.id} must advance exactly one version`);
  assert(canonical(immutablePart(kind, existing)) === canonical(immutablePart(kind, record)), `${kind} ${record.id} may change only its versioned state`);
  // A corrupt stored predecessor is not a base to transition from.
  validateAuthorityRecord(kind, existing, { projectId: projectOf(store) });
  TRANSITIONS[kind](existing, record, store);
  return store.put(kind, record);
}

// Request references come from the task's own originalRequest (#5). A task
// without one has unknown request provenance; nothing is reconstructed.
export function requestRefs(brief) {
  const request = brief.originalRequest;
  if (!request) return [];
  return [{ field: 'originalRequest', origin: request.origin, source: request.source, date: request.date, digest: digest(request), verbatim: typeof request.text === 'string' }];
}
// Append the immutable snapshot of one task revision. Re-recording the same
// revision keeps the first snapshot; a different brief under a recorded
// revision is refused rather than overwritten.
export function recordTaskRevision(store, { taskId, revision, brief, previousRevision = null, recordedBy, at = now() }) {
  requireLedger(store);
  // Store the brief as it persists (undefined fields dropped), so its digest survives a reload.
  brief = JSON.parse(JSON.stringify(brief));
  const projectId = projectOf(store), key = taskRevisionId(projectId, taskId, revision), existing = store.get('taskRevision', key);
  // One snapshot per distinct revision: a revision that returns keeps its first snapshot.
  if (existing) return existing;
  const refs = requestRefs(brief);
  const row = { schemaVersion: RECORD_SCHEMA_VERSION, id: key, projectId, taskId, revision, brief, briefDigest: digest(brief), requestRefs: refs, requestCoverage: refs.length ? 'recorded' : 'unknown', previousRevision: previousRevision === revision ? null : previousRevision, recordedBy, createdAt: at, ...(recordedBy === 'migration' ? { historyIncomplete: true } : {}) };
  return putAuthorityRecord(store, 'taskRevision', row);
}
export const taskRevisions = (store, taskId) => store.all('taskRevision').filter(row => row.taskId === taskId);
export const taskAuthorityRevision = (store, taskId) => store.get('taskAuthority', taskId)?.authorityRevision ?? 0;
// The per-task authority revision is a cache invalidator for later boundary
// checks. It only increases; record validation remains authoritative.
export function bumpTaskAuthority(store, taskId, cause, ref) {
  requireLedger(store);
  const current = store.get('taskAuthority', taskId), previous = current?.authorityRevision ?? 0;
  const row = { schemaVersion: RECORD_SCHEMA_VERSION, id: taskId, projectId: projectOf(store), taskId, authorityRevision: previous + 1, updatedAt: now(), lastChange: { cause, ...(ref ? { ref } : {}) } };
  putAuthorityRecord(store, 'taskAuthority', row, { expectedVersion: previous }); return row.authorityRevision;
}
// Called by task.put and recurrence after a task row changes. Only a new
// revision appends a snapshot and advances the task's authority revision.
export function noteTaskRevision(store, task, { previousRevision = null, brief, recordedBy }) {
  if (!authorityLedgerEnabled(store) || previousRevision === task.revision) return null;
  const snapshot = recordTaskRevision(store, { taskId: task.id, revision: task.revision, brief, previousRevision, recordedBy });
  bumpTaskAuthority(store, task.id, 'task-revision', task.revision);
  return snapshot;
}

// Validate every authority record and its references. A missing or corrupt
// reference fails closed: callers refuse to proceed and report the repair reason.
// An active disposition must exactly cover the decision that names it; inactive
// dispositions are history and keep only their references.
const DISPOSITION_STATUS = { answer: 'resolved', cancel: 'canceled', supersede: 'superseded' };
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
// The exact cancel or supersede payload a grant entry pins (its payloadDigest).
const DISPOSITION_PAYLOAD = { cancel: 'cancellation', supersede: 'supersession' };
export const dispositionPayloadDigest = d => digest({ kind: d.kind, payload: d[DISPOSITION_PAYLOAD[d.kind]] });
// authorityUse.subjectDigest: a digest of the exact semantic subject one use
// authorized, and nothing else. For a task approval: the operation, the task, its
// exact revision and the selected workflow digest. For a decision disposition or
// ratification: the operation and permitted disposition, the decision identity and
// the version answered, its scope and option-set digests, the exact task revisions
// covered (sorted), and the selected answer (option id and payload digest) or, for
// cancel and supersede, the exact payload digest; a ratification also names the
// inactive answer it restores. The audit recomputes it from the records the use
// backs (disposition, grant entry, or the task's current approval).
export const authoritySubjectDigest = subject => digest({ kind: 'authoritySubject', subjectVersion: 1, ...subject });
export const approvalSubject = ({ taskId, taskRevision, workflowDigest }) => ({ operation: 'task.approve', disposition: 'approve', taskId, taskRevision, workflowDigest });
export const dispositionSubject = d => ({
  operation: d.ratifiesDispositionId ? 'decision.ratify' : 'decision.dispose', disposition: d.ratifiesDispositionId ? 'ratify' : d.kind,
  decisionId: d.obligationId, decisionVersion: d.obligationVersion, scopeDigest: d.scopeDigest, optionSetDigest: d.optionSetDigest,
  revisions: d.applicability.map(a => `${a.taskId}@${a.revision}`).sort(),
  ...(d.kind === 'answer' ? { answer: { optionId: d.answer.optionId, payloadDigest: d.answer.payloadDigest } } : { payloadDigest: dispositionPayloadDigest(d) }),
  ...(d.ratifiesDispositionId ? { ratifies: d.ratifiesDispositionId } : {}),
});
// Whether a recorded revision of a task descends from an earlier one, following
// the immutable snapshots' previousRevision links.
function revisionDescends(rows, projectId, taskId, revision, ancestor) {
  const seen = new Set([revision]);
  let snapshot = rows.taskRevision.get(taskRevisionId(projectId, taskId, revision));
  while (snapshot?.previousRevision && !seen.has(snapshot.previousRevision)) {
    if (snapshot.previousRevision === ancestor) return true;
    seen.add(snapshot.previousRevision);
    snapshot = rows.taskRevision.get(taskRevisionId(projectId, taskId, snapshot.previousRevision));
  }
  return false;
}
// A disposition's authority must be the authority for exactly that disposition:
// the same command, the disposition kind the use permitted and, for a grant use,
// everything its entry pins. Direct operator ratification restores an inactive
// answer of the same decision unchanged and nothing else.
function auditDispositionAuthority(d, use, rows, problem) {
  const fail = reason => problem('decisionDisposition', d.id, reason);
  if (use.commandId !== d.commandId) fail(`authority use ${use.id} was recorded by command ${use.commandId}, not ${d.commandId}`);
  if (use.operation === 'decision.ratify') {
    // Ratification names the one inactive answer it restores and repeats it exactly:
    // same decision, answer, scope, options and applicable revisions. A changed
    // revision needs fresh disposition authority, never ratification.
    if (d.kind !== 'answer') return fail(`ratification restores an answer; it cannot authorize a ${d.kind} disposition`);
    const p = d.ratifiesDispositionId ? rows.decisionDisposition.get(d.ratifiesDispositionId) : undefined;
    const revisions = x => x.applicability.map(a => `${a.taskId}@${a.revision}`);
    if (!p) return fail(`ratification names no inactive disposition it restores`);
    if (!(p.obligationId === d.obligationId && p.status === 'inactive' && p.kind === 'answer' && p.answer.optionId === d.answer.optionId && p.answer.payloadDigest === d.answer.payloadDigest && p.scopeDigest === d.scopeDigest && p.optionSetDigest === d.optionSetDigest && sameSet(revisions(p), revisions(d)))) fail(`ratification of ${p.id} does not repeat an inactive answer of decision ${d.obligationId} with the same answer, scope, options and revisions`);
    return;
  }
  if (d.ratifiesDispositionId) fail(`only direct operator ratification can name a disposition it restores`);
  if (use.disposition !== d.kind) fail(`authority use ${use.id} permits ${use.disposition}, not this ${d.kind} disposition`);
  if (use.source !== 'grant') return;
  const g = rows.operatorGrant.get(use.grantId), e = g?.entries.find(x => x.entryId === use.entryId);
  if (!e) return; // reported on the authority use
  const where = `grant entry ${g.id}/${e.entryId}`;
  if (e.operation !== 'decision.dispose' || e.disposition !== d.kind) return fail(`${where} permits ${e.operation}/${e.disposition}, not a ${d.kind} disposition`);
  if (e.obligationId !== d.obligationId || e.obligationVersion !== d.obligationVersion) fail(`${where} pins decision ${e.obligationId} version ${e.obligationVersion}, not ${d.obligationId} version ${d.obligationVersion}`);
  if (e.scopeDigest !== d.scopeDigest) fail(`${where} pins a different scope than the disposition`);
  if (e.optionSetDigest !== d.optionSetDigest) fail(`${where} pins a different option set than the disposition`);
  for (const a of d.applicability) if (a.taskId !== e.taskId || a.revision !== e.taskRevision) fail(`${where} pins ${e.taskId}@${e.taskRevision}; it cannot authorize ${a.taskId}@${a.revision}`);
  if (d.kind === 'answer') { if (!e.answers.some(a => a.optionId === d.answer.optionId && a.payloadDigest === d.answer.payloadDigest)) fail(`${where} does not permit answer ${d.answer.optionId}`); }
  else if (e.payloadDigest !== dispositionPayloadDigest(d)) fail(`${where} pins a different ${DISPOSITION_PAYLOAD[d.kind]} payload than the disposition`);
}
// With taskId, the audit is scoped to what decision commands write for that one
// task: its snapshots, authority revision, decisions, their dispositions, the
// uses those cite and the grants those uses name (entries on this task only).
// Migration, reports and release reviews are left to the full audit. SQLite
// selects the scoped rows; only they are parsed and validated.
const TASK_SCOPED = "SELECT id FROM records WHERE kind='decisionObligation' AND json_extract(data,'$.taskId')=?1";
// A task's uses: those its dispositions cite, and the one its current approval rests on.
const TASK_USES = `SELECT json_extract(data,'$.authorityUseId') FROM records WHERE kind='decisionDisposition' AND json_extract(data,'$.obligationId') IN (${TASK_SCOPED}) UNION SELECT json_extract(data,'$.approvalAuthority.authorityUseId') FROM records WHERE kind='task' AND id=?1`;
const SCOPED_ROWS = {
  taskRevision: "kind='taskRevision' AND json_extract(data,'$.taskId')=?1",
  taskAuthority: "kind='taskAuthority' AND json_extract(data,'$.taskId')=?1",
  decisionObligation: "kind='decisionObligation' AND json_extract(data,'$.taskId')=?1",
  decisionDisposition: `kind='decisionDisposition' AND json_extract(data,'$.obligationId') IN (${TASK_SCOPED})`,
  authorityUse: `kind='authorityUse' AND id IN (${TASK_USES})`,
  // Grants used by this task's records, and every grant with an entry on this task.
  operatorGrant: `kind='operatorGrant' AND (id IN (SELECT json_extract(data,'$.grantId') FROM records WHERE kind='authorityUse' AND id IN (${TASK_USES})) OR EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.entries')) WHERE json_extract(value,'$.taskId')=?1))`,
  relayedAnswer: "kind='relayedAnswer' AND json_extract(data,'$.taskId')=?1",
};
function auditRows(store, kind, taskId) {
  if (taskId === undefined) return store.db.prepare('SELECT id,data FROM records WHERE kind=? ORDER BY rowid').all(kind);
  return SCOPED_ROWS[kind] ? store.db.prepare(`SELECT id,data FROM records WHERE ${SCOPED_ROWS[kind]} ORDER BY rowid`).all(taskId) : [];
}
export function auditAuthorityRecords(store, { limit = 50, taskId } = {}) {
  if (!authorityLedgerEnabled(store)) return [];
  const problems = [], projectId = projectOf(store), rows = Object.fromEntries(AUTHORITY_KINDS.map(kind => [kind, new Map()]));
  const problem = (kind, key, reason) => { if (problems.length < limit) problems.push({ kind, id: key, reason }); };
  for (const kind of AUTHORITY_KINDS) {
    let found; try { found = auditRows(store, kind, taskId); } catch (error) { problem(kind, `task:${taskId}`, `records could not be read: ${error.message}`); continue; }
    for (const row of found) {
      let record; try { record = JSON.parse(row.data); } catch { problem(kind, row.id, 'record is not JSON'); continue; }
      try { validateAuthorityRecord(kind, record, { projectId }); assert(record.id === row.id, 'record id disagrees with its key'); rows[kind].set(record.id, record); }
      catch (error) { problem(kind, row.id, error.message); }
    }
  }
  // Task and revision references: a recorded revision has its snapshot, and a
  // snapshotted task exists with an authority revision.
  const taskKnown = taskId => rows.taskAuthority.has(taskId) && store.get('task', taskId) !== undefined;
  const revisionKnown = (taskId, revision) => taskKnown(taskId) && rows.taskRevision.has(taskRevisionId(projectId, taskId, revision));
  const needRevision = (kind, key, taskId, revision, what) => { if (!revisionKnown(taskId, revision)) problem(kind, key, `${what} names unrecorded revision ${taskId}@${revision}`); };
  for (const r of rows.taskRevision.values()) if (!taskKnown(r.taskId)) problem('taskRevision', r.id, `task ${r.taskId} is missing or has no authority revision`);
  for (const a of rows.taskAuthority.values()) if (store.get('task', a.taskId) === undefined) problem('taskAuthority', a.id, `task ${a.taskId} is missing`);
  for (const o of rows.decisionObligation.values()) {
    if (!taskKnown(o.taskId)) problem('decisionObligation', o.id, `task ${o.taskId} is missing or has no authority revision`);
    for (const a of o.applicability) needRevision('decisionObligation', o.id, a.taskId, a.revision, 'applicability');
    if (o.activeDispositionId) {
      const d = rows.decisionDisposition.get(o.activeDispositionId);
      if (!d || d.obligationId !== o.id) problem('decisionObligation', o.id, `active disposition ${o.activeDispositionId} missing or belongs elsewhere`);
      else if (d.status !== 'active') problem('decisionObligation', o.id, `active disposition ${d.id} is inactive`);
      else {
        // Exact coverage: the clearing disposition answered this scope, these options and these revisions.
        if (DISPOSITION_STATUS[d.kind] !== o.status) problem('decisionObligation', o.id, `a ${o.status} decision cannot be cleared by a ${d.kind} disposition`);
        if (d.scopeDigest !== o.scopeDigest) problem('decisionObligation', o.id, `active disposition ${d.id} covers a different scope`);
        if (d.optionSetDigest !== o.optionSetDigest) problem('decisionObligation', o.id, `active disposition ${d.id} answered a different option set`);
        if (d.obligationVersion > o.version) problem('decisionObligation', o.id, `active disposition ${d.id} names a later decision version`);
        if (d.kind === 'answer' && !o.options.some(x => x.id === d.answer.optionId && x.payloadDigest === d.answer.payloadDigest)) problem('decisionObligation', o.id, `active disposition ${d.id} selects an answer outside the decision options`);
        const named = d.applicability.map(a => `${a.taskId}@${a.revision}`), held = o.applicability.map(a => `${a.taskId}@${a.revision}`);
        for (const key of named) if (!held.includes(key)) problem('decisionObligation', o.id, `active disposition ${d.id} applies to ${key}, which the decision does not`);
        for (const a of o.applicability) if (a.state === 'covered' && !named.includes(`${a.taskId}@${a.revision}`)) problem('decisionObligation', o.id, `applicability ${a.taskId}@${a.revision} is marked covered but its disposition does not apply to it`);
        if (d.kind === 'supersede' && !sameSet(o.supersededBy ?? [], d.supersession.replacements)) problem('decisionObligation', o.id, `replacements disagree with disposition ${d.id}`);
      }
    }
    for (const next of o.supersededBy ?? []) if (!rows.decisionObligation.has(next)) problem('decisionObligation', o.id, `replacement decision ${next} is missing`);
    // A reopening restates exactly the scope of a superseded decision of the same task.
    if (o.reopens !== undefined) {
      const prior = rows.decisionObligation.get(o.reopens);
      if (!prior || prior.taskId !== o.taskId || prior.scopeDigest !== o.scopeDigest || prior.status !== 'superseded') problem('decisionObligation', o.id, `reopens decision ${o.reopens}, which is missing, not superseded, or has another task or scope`);
    }
    // A reopening chain ends at an original decision: no cycles.
    const seen = new Set([o.id]);
    let at = o;
    while (at?.reopens !== undefined && !seen.has(at.reopens)) { seen.add(at.reopens); at = rows.decisionObligation.get(at.reopens); }
    if (at?.reopens !== undefined) problem('decisionObligation', o.id, 'reopening chain is cyclic and never reaches an original decision');
  }
  // Supersession must be acyclic across obligations and dispositions.
  const successors = key => [...(rows.decisionObligation.get(key)?.supersededBy ?? []), ...[...rows.decisionDisposition.values()].filter(d => d.obligationId === key && d.kind === 'supersede').flatMap(d => d.supersession.replacements)];
  const state = new Map();
  const visit = key => { if (state.get(key) === 'done') return false; if (state.get(key) === 'active') return true; state.set(key, 'active'); const cyclic = successors(key).some(visit); state.set(key, 'done'); return cyclic; };
  for (const key of rows.decisionObligation.keys()) if (!state.has(key) && visit(key)) problem('decisionObligation', key, 'supersession cycle');
  // One authority use authorizes exactly one disposition, active or historical, and an
  // inactive answer is ratified at most once: a counted use cannot back two outcomes.
  const citing = new Map(), ratifying = new Map();
  for (const d of rows.decisionDisposition.values()) {
    citing.set(d.authorityUseId, [...(citing.get(d.authorityUseId) ?? []), d.id]);
    if (d.ratifiesDispositionId) ratifying.set(d.ratifiesDispositionId, [...(ratifying.get(d.ratifiesDispositionId) ?? []), d.id]);
  }
  // Scoped to one task, also count dispositions elsewhere that cite this task's uses,
  // so a use shared with another task's disposition is still caught.
  // One scan of dispositions for all of this task's uses together.
  if (taskId !== undefined && citing.size) {
    const rowsCiting = store.db.prepare("SELECT id, json_extract(data,'$.authorityUseId') AS useId FROM records WHERE kind='decisionDisposition' AND json_extract(data,'$.authorityUseId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(JSON.stringify([...citing.keys()]));
    for (const r of rowsCiting) { const ids = citing.get(r.useId); if (!ids.includes(r.id)) ids.push(r.id); }
  }
  for (const [useId, ids] of citing) if (ids.length > 1) problem('authorityUse', useId, `authorizes ${ids.length} dispositions (${ids.join(', ')}); one use authorizes exactly one`);
  for (const [prior, ids] of ratifying) if (ids.length > 1) problem('decisionDisposition', prior, `is ratified by ${ids.length} dispositions (${ids.join(', ')})`);
  // A ratification chain ends at an ordinary answer: no cycles, no dangling links.
  for (const d of rows.decisionDisposition.values()) if (d.ratifiesDispositionId) {
    const seen = new Set([d.id]);
    let at = rows.decisionDisposition.get(d.ratifiesDispositionId);
    while (at?.ratifiesDispositionId && !seen.has(at.id)) { seen.add(at.id); at = rows.decisionDisposition.get(at.ratifiesDispositionId); }
    if (!at || seen.has(at.id)) problem('decisionDisposition', d.id, `ratification chain does not end at an original answer`);
  }
  for (const d of rows.decisionDisposition.values()) {
    const o = rows.decisionObligation.get(d.obligationId); if (!o) problem('decisionDisposition', d.id, `decision ${d.obligationId} is missing`);
    const use = rows.authorityUse.get(d.authorityUseId);
    if (!use) problem('decisionDisposition', d.id, `authority use ${d.authorityUseId} is missing`);
    else if (!['decision.dispose', 'decision.ratify'].includes(use.operation)) problem('decisionDisposition', d.id, `authority use ${use.id} authorized ${use.operation}, not a decision disposition`);
    else {
      if (d.status === 'active' && use.status !== 'active') problem('decisionDisposition', d.id, `active disposition rests on inactive authority use ${use.id}`);
      if (use.subjectDigest !== authoritySubjectDigest(dispositionSubject(d))) problem('authorityUse', use.id, `subject digest is not the digest of disposition ${d.id}'s exact subject`);
      auditDispositionAuthority(d, use, rows, problem);
    }
    // A relayed answer cited by a disposition is the same answer to the same decision:
    // applied through the grant use that backs it, or confirmed by the operator directly.
    if (d.relayedAnswerId !== undefined) {
      const r = rows.relayedAnswer.get(d.relayedAnswerId);
      if (!r) problem('decisionDisposition', d.id, `cites relayed answer ${d.relayedAnswerId}, which is missing`);
      else {
        if (d.kind !== 'answer' || r.decisionId !== d.obligationId || r.selected.optionId !== d.answer.optionId || r.selected.payloadDigest !== d.answer.payloadDigest) problem('decisionDisposition', d.id, `cites relayed answer ${r.id}, which relayed a different answer or decision`);
        if (!['applied', 'confirmed'].includes(r.status) || r.dispositionId !== d.id) problem('decisionDisposition', d.id, `cites relayed answer ${r.id}, which does not name this disposition as applying or confirming it`);
        if (use && (r.status === 'applied') !== (use.source === 'grant')) problem('decisionDisposition', d.id, `relayed answer ${r.id} is ${r.status}, but the disposition rests on ${use.source} authority`);
      }
    }
    // A grant-backed answer was entered by someone other than the operator: it must rest on
    // the relayed answer that records the operator's words. (A grant-backed cancellation's
    // exact reason is pinned by the operator in the grant entry itself.)
    if (use?.source === 'grant' && d.kind === 'answer' && d.relayedAnswerId === undefined) problem('decisionDisposition', d.id, 'grant-backed answer has no relayed answer recording the operator\'s words, the channel and who entered it');
    // An active disposition is the one its decision names; anything else is history marked inactive.
    if (o && d.status === 'active' && o.activeDispositionId !== d.id) problem('decisionDisposition', d.id, `active disposition is not the one decision ${o.id} names`);
    for (const a of d.applicability) needRevision('decisionDisposition', d.id, a.taskId, a.revision, 'applicability');
    if (d.kind === 'supersede') {
      for (const next of d.supersession.replacements) if (!rows.decisionObligation.has(next)) problem('decisionDisposition', d.id, `replacement decision ${next} is missing`);
      // A scope removal is tied to a recorded revised brief of the decision's own task, after its origin.
      const revised = d.supersession.revisedRevision;
      if (revised !== undefined && o) {
        if (!rows.taskRevision.has(taskRevisionId(projectId, o.taskId, revised))) problem('decisionDisposition', d.id, `supersession names revised revision ${o.taskId}@${revised}, which has no task revision snapshot`);
        else if (!revisionDescends(rows, projectId, o.taskId, revised, o.originRevision)) problem('decisionDisposition', d.id, `supersession revised revision ${o.taskId}@${revised} is not a later revision of origin ${o.originRevision}`);
      }
    }
  }
  for (const g of rows.operatorGrant.values()) for (const e of g.entries) {
    if (taskId !== undefined && e.taskId !== taskId) continue;
    needRevision('operatorGrant', g.id, e.taskId, e.taskRevision, `entry ${e.entryId}`);
    if (e.operation !== 'decision.dispose') continue;
    // A decision entry pins an existing decision exactly as it was: its task and
    // revision, a version it reached, its scope and options, and only its answers.
    const o = rows.decisionObligation.get(e.obligationId), where = `entry ${e.entryId}`;
    if (!o) { problem('operatorGrant', g.id, `${where} names missing decision ${e.obligationId}`); continue; }
    if (e.taskId !== o.taskId || !o.applicability.some(a => a.taskId === e.taskId && a.revision === e.taskRevision)) problem('operatorGrant', g.id, `${where} names ${e.taskId}@${e.taskRevision}, which decision ${o.id} does not apply to`);
    if (e.obligationVersion > o.version) problem('operatorGrant', g.id, `${where} pins decision ${o.id} version ${e.obligationVersion}, later than its version ${o.version}`);
    if (e.scopeDigest !== o.scopeDigest) problem('operatorGrant', g.id, `${where} pins a different scope than decision ${o.id}`);
    if (e.optionSetDigest !== o.optionSetDigest) problem('operatorGrant', g.id, `${where} pins a different option set than decision ${o.id}`);
    for (const a of e.answers ?? []) if (!o.options.some(x => x.id === a.optionId && x.payloadDigest === a.payloadDigest)) problem('operatorGrant', g.id, `${where} allows answer ${a.optionId}, which is not an option of decision ${o.id}`);
  }
  for (const r of rows.relayedAnswer.values()) {
    const o = rows.decisionObligation.get(r.decisionId);
    if (!o) problem('relayedAnswer', r.id, `decision ${r.decisionId} is missing`);
    else {
      if (o.taskId !== r.taskId || o.scopeDigest !== r.scopeDigest || o.optionSetDigest !== r.optionSetDigest || r.decisionVersion > o.version) problem('relayedAnswer', r.id, `relays an answer to a different task, scope, option set or a later version of decision ${o.id}`);
      if (!o.options.some(x => x.id === r.selected.optionId && x.payloadDigest === r.selected.payloadDigest)) problem('relayedAnswer', r.id, `relays answer ${r.selected.optionId}, which is not an option of decision ${o.id}`);
    }
    needRevision('relayedAnswer', r.id, r.taskId, r.taskRevision, 'relay');
    if (r.dispositionId !== undefined) { const d = rows.decisionDisposition.get(r.dispositionId); if (!d || d.relayedAnswerId !== r.id) problem('relayedAnswer', r.id, `names disposition ${r.dispositionId}, which does not cite it`); }
  }
  // Approval provenance: a task's current approval names the use it rests on, and that
  // use authorized exactly this task revision and workflow.
  const approvalTasks = taskId === undefined ? store.all('task') : [store.get('task', taskId)].filter(Boolean);
  for (const t of approvalTasks) if (t.approvalAuthority && t.approvedRevision === t.revision && t.approvalAuthority.authorityUseId) {
    const a = t.approvalAuthority, u = rows.authorityUse.get(a.authorityUseId);
    if (!u) { problem('task', t.id, `approval rests on missing authority use ${a.authorityUseId}`); continue; }
    if (u.operation !== 'task.approve' || u.source !== a.source) problem('task', t.id, `approval names authority use ${u.id}, which authorized ${u.source} ${u.operation}`);
    if (u.status !== 'active') problem('task', t.id, `current approval rests on inactive authority use ${u.id}`);
    if (t.approvedWorkflow && t.approvedWorkflow.digest !== a.workflowDigest) problem('task', t.id, 'approval provenance names a different workflow than the approval binding');
    if (u.subjectDigest !== authoritySubjectDigest(approvalSubject({ taskId: t.id, taskRevision: t.approvedRevision, workflowDigest: a.workflowDigest }))) problem('authorityUse', u.id, `subject digest is not the digest of task ${t.id}'s current approval`);
    if (u.source === 'grant' && (u.grantId !== a.grantId || u.entryId !== a.entryId)) problem('task', t.id, `approval provenance names grant entry ${a.grantId}/${a.entryId}, but use ${u.id} consumed ${u.grantId}/${u.entryId}`);
  }
  const usesOf = new Map();
  for (const u of rows.authorityUse.values()) if (u.source === 'grant') {
    const g = rows.operatorGrant.get(u.grantId), e = g?.entries.find(x => x.entryId === u.entryId);
    if (!e) { problem('authorityUse', u.id, `grant entry ${u.grantId}/${u.entryId} is missing`); continue; }
    if (e.operation === 'task.approve' && u.subjectDigest !== authoritySubjectDigest(approvalSubject({ taskId: e.taskId, taskRevision: e.taskRevision, workflowDigest: e.workflowDigest }))) problem('authorityUse', u.id, `subject digest is not the exact approval grant entry ${g.id}/${e.entryId} pins`);
    if (u.grantVersion > g.version) problem('authorityUse', u.id, `names grant version ${u.grantVersion}, later than ${g.id} version ${g.version}`);
    if (u.operation !== e.operation || u.disposition !== e.disposition) problem('authorityUse', u.id, `binding ${u.operation}/${u.disposition} is not what grant entry ${g.id}/${e.entryId} permits`);
    const at = Date.parse(u.createdAt); if (at < Date.parse(g.notBefore) || at >= Date.parse(g.expiresAt)) problem('authorityUse', u.id, `used grant ${g.id} outside its validity interval`);
    const key = `${g.id}/${e.entryId}`; usesOf.set(key, (usesOf.get(key) ?? 0) + 1);
  }
  // Every recorded use consumed its entry: usage below the recorded uses is restored, spent authority.
  for (const [key, count] of usesOf) { const [grantId, entryId] = key.split('/'); const used = rows.operatorGrant.get(grantId).usage[entryId] ?? 0; if (used < count) problem('operatorGrant', grantId, `entry ${entryId} records ${used} use(s) but ${count} authority use(s) cite it`); }
  for (const r of rows.decisionReport.values()) {
    needRevision('decisionReport', r.id, r.taskId, r.taskRevision, 'report');
    if (r.previousReportId && !rows.decisionReport.has(r.previousReportId)) problem('decisionReport', r.id, `previous report ${r.previousReportId} is missing`);
    for (const c of r.choices) if (c.obligationId && !rows.decisionObligation.has(c.obligationId)) problem('decisionReport', r.id, `choice ${c.localId} links missing decision ${c.obligationId}`);
  }
  for (const v of rows.releaseReview.values()) {
    const use = rows.authorityUse.get(v.authorityUseId);
    if (!use) problem('releaseReview', v.id, `authority use ${v.authorityUseId} is missing`);
    else if (use.operation !== 'release.review') problem('releaseReview', v.id, `authority use ${use.id} authorized ${use.operation}, not a release review`);
    else if (v.status === 'active' && use.status !== 'active') problem('releaseReview', v.id, `active review rests on inactive authority use ${use.id}`);
    for (const i of v.manifest.included) needRevision('releaseReview', v.id, i.taskId, i.revision, 'manifest');
    for (const x of v.manifest.reports) { const r = rows.decisionReport.get(x.reportId); if (!r || r.reportVersion !== x.reportVersion || r.bodyDigest !== x.bodyDigest) problem('releaseReview', v.id, `reviewed report ${x.reportId} is missing or changed`); }
  }
  if (taskId === undefined) auditMigration(store, rows, projectId, problem);
  return problems;
}
// The migration record must agree with what the migration wrote: its identity,
// counts and inventory digest are recomputed from the immutable snapshot and
// inventory facts it left behind.
function auditMigration(store, rows, projectId, problem) {
  let marker; try { marker = validateMigrationMarker(store); } catch (error) { problem('authorityMigration', 'meta', error.message); return; }
  const snapshots = [...rows.taskRevision.values()].filter(r => r.recordedBy === 'migration'), legacy = [...rows.legacyAuthority.values()];
  for (const row of legacy) {
    if (row.migrationId !== marker.migrationId) problem('legacyAuthority', row.id, 'names another migration');
    if (row.subject.revision && !rows.taskRevision.has(taskRevisionId(projectId, row.subject.taskId, row.subject.revision))) problem('legacyAuthority', row.id, `names unrecorded revision ${row.subject.taskId}@${row.subject.revision}`);
  }
  for (const r of snapshots) if (!rows.taskAuthority.has(r.taskId)) problem('taskRevision', r.id, `migrated task ${r.taskId} has no authority revision`);
  const counts = { snapshots: snapshots.length, requestUnknown: snapshots.filter(r => r.requestCoverage === 'unknown').length, legacy: legacy.length };
  if (counts.snapshots !== marker.counts.snapshots || counts.requestUnknown !== marker.counts.requestUnknown) problem('authorityMigration', marker.migrationId, `records ${marker.counts.snapshots} snapshot(s) (${marker.counts.requestUnknown} with unknown request) but ${counts.snapshots} (${counts.requestUnknown}) exist`);
  if (counts.legacy !== marker.counts.retained + marker.counts.held) problem('authorityMigration', marker.migrationId, `records ${marker.counts.retained + marker.counts.held} inventory item(s) but ${counts.legacy} exist`);
  if (legacy.filter(r => legacyInitialStatus(r.classification) === 'held').length !== marker.counts.held) problem('authorityMigration', marker.migrationId, 'held inventory count disagrees with the inventory');
  const items = legacy.map(({ id: key, item, subject, classification, reasons, evidence }) => ({ id: key, item, subject, classification, status: legacyInitialStatus(classification), reasons, ...(evidence ? { evidence } : {}) }));
  if (migrationInventoryDigest(projectId, snapshots, items) !== marker.inventoryDigest) problem('authorityMigration', marker.migrationId, 'inventory digest does not match the migrated snapshots and inventory');
}
export function assertAuthorityRecordsSound(store, action) {
  const problems = auditAuthorityRecords(store, { limit: 5 });
  assert(!problems.length, `${action} refused: decision-authority records need repair: ${problems.map(p => `${p.kind} ${p.id}: ${p.reason}`).join('; ')}`);
}

const unresolvedApplicability = o => o.applicability.some(a => a.state !== 'covered');
export const unresolvedDecisions = store => authorityLedgerEnabled(store) ? store.all('decisionObligation').filter(o => o.status === 'unresolved' || unresolvedApplicability(o)) : [];
// Retention roots: every authority record is kept (records are never pruned),
// so retention protects what they reference: cited paths are found by the
// generic citation scan, and flows they name keep their workspaces.
export function authorityRetentionRoots(store) {
  if (!authorityLedgerEnabled(store)) return { flowIds: new Set(), unresolved: [] };
  const flowIds = new Set();
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (key === 'flowId' && typeof item === 'string') flowIds.add(item); else walk(item); }
  };
  for (const kind of AUTHORITY_KINDS) for (const row of store.all(kind)) walk(row);
  return { flowIds, unresolved: unresolvedDecisions(store).map(o => o.id) };
}

// Read model for status output and the snapshot: what the migration found and
// what is still held. "enforcement: not-wired" is literal: this slice records
// holds but no boundary consults them yet.
export function authorityStatus(store, { limit = 50 } = {}) {
  const schemaVersion = store.meta('schemaVersion');
  if (!authorityLedgerEnabled(store)) return { schemaVersion, ledger: false };
  const legacy = store.all('legacyAuthority'), held = legacy.filter(row => row.status === 'held');
  return {
    schemaVersion, ledger: true, enforcement: 'not-wired', migration: store.meta('authorityMigration'), hold: store.meta('authorityHold', null),
    legacy: { total: legacy.length, held: held.length, retained: legacy.length - held.length, heldItems: held.slice(0, limit).map(({ id: key, item, subject, classification, reasons }) => ({ id: key, item, subject, classification, reasons })) },
    unresolvedDecisions: unresolvedDecisions(store).length,
  };
}
