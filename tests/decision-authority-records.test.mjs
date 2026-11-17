import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { AUTHORITY_KINDS, auditAuthorityRecords, authoritySubjectDigest, dispositionSubject, dispositionPayloadDigest, optionSetDigest, putAuthorityRecord, recordTaskRevision, reportBodyDigest, taskAuthorityRevision, taskRevisionId, taskRevisions, validateAuthorityRecord } from '../starter/factory/core/decision-authority.mjs';
import { LATER, R1, migrated, samples } from './authority-fixtures.mjs';

const clone = value => structuredClone(value);
// The subject digest an authority use must carry for the disposition it backs (slice C).
const subjectOf = disposition => authoritySubjectDigest(dispositionSubject(disposition));

test('every record kind validates its fictional sample and refuses unknown fields at any depth', () => {
  const s = samples('project-1');
  for (const [kind, record] of [['decisionObligation', s.decisionObligation], ['operatorGrant', s.operatorGrant], ['authorityUse', s.authorityUse], ['authorityUse', s.directUse], ['decisionDisposition', s.decisionDisposition], ['decisionReport', s.decisionReport], ['releaseReview', s.releaseReview]]) {
    assert.equal(validateAuthorityRecord(kind, record), record);
    assert.throws(() => validateAuthorityRecord(kind, { ...record, approvedByProse: true }), /unknown field approvedByProse/);
    assert.throws(() => validateAuthorityRecord(kind, { ...record, schemaVersion: 2 }), /schemaVersion/);
    assert.throws(() => validateAuthorityRecord(kind, record, { projectId: 'other-project' }), /another project/);
  }
  const grant = clone(s.operatorGrant); grant.entries[0].allFutureRevisions = true;
  assert.throws(() => validateAuthorityRecord('operatorGrant', grant), /unknown field allFutureRevisions/);
  const nested = clone(s.decisionObligation); nested.scope.anyTask = true;
  assert.throws(() => validateAuthorityRecord('decisionObligation', nested), /unknown field anyTask/);
  assert.throws(() => validateAuthorityRecord('noSuchKind', {}), /unknown authority record kind/);
  assert.deepEqual([...AUTHORITY_KINDS].sort(), ['authorityUse', 'decisionDisposition', 'decisionObligation', 'decisionReport', 'legacyAuthority', 'operatorGrant', 'relayedAnswer', 'releaseReview', 'taskAuthority', 'taskRevision']);
});

test('oversized text, lists and payloads are refused', () => {
  const s = samples('project-1');
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...s.decisionObligation, question: 'x'.repeat(4001) }), /question: expected text of 1-4000/);
  const options = Array.from({ length: 17 }, (_, i) => ({ id: `option-${i}`, label: 'Fictional option', payloadDigest: digest(i) }));
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...s.decisionObligation, options, optionSetDigest: optionSetDigest(options) }), /options: expected a list of 1-16/);
  const entry = s.operatorGrant.entries[0], entries = Array.from({ length: 101 }, (_, i) => ({ ...entry, entryId: `approve-${i}` }));
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...s.operatorGrant, entries }), /entries: expected a list of 1-100/);
  // 100 entries that each fit their own bounds still exceed the 32 KiB grant payload.
  const wide = Array.from({ length: 100 }, (_, i) => ({ entryId: `answer-${i}`, taskId: 'task-1', taskRevision: R1, operation: 'decision.dispose', disposition: 'answer', maxUses: 1, obligationId: 'decision-1', obligationVersion: 1, scopeDigest: digest(i), optionSetDigest: digest(i + 1), answers: [{ optionId: 'json', payloadDigest: digest(i + 2) }] }));
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...s.operatorGrant, entries: wide }), /larger than/);
  assert.throws(() => validateAuthorityRecord('decisionReport', { ...s.decisionReport, choices: Array.from({ length: 65 }, (_, i) => ({ ...s.decisionReport.choices[0], localId: `c${i}` })) }), /choices: expected a list of 0-64/);
  assert.throws(() => validateAuthorityRecord('releaseReview', { ...s.releaseReview, dispositions: [{ ...s.releaseReview.dispositions[0], rationale: 'r'.repeat(2001) }] }), /rationale/);
});

test('grants pin exact scope: no wildcards, prose, missing pins or overuse', () => {
  const s = samples('project-1'), grant = s.operatorGrant;
  const entry = patch => ({ ...grant, entries: [{ ...grant.entries[0], ...patch }] });
  assert.throws(() => validateAuthorityRecord('operatorGrant', entry({ taskRevision: '*' })), /taskRevision: expected a sha-256 digest/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', entry({ taskId: '*' })), /taskId: expected an identifier/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', entry({ scope: 'any product question' })), /unknown field scope/);
  const noWorkflow = clone(grant); delete noWorkflow.entries[0].workflowDigest;
  assert.throws(() => validateAuthorityRecord('operatorGrant', noWorkflow), /task approval pins exactly a task revision and workflow/);
  // A batch approval entry cannot also carry a product answer.
  assert.throws(() => validateAuthorityRecord('operatorGrant', entry({ answers: [{ optionId: 'json', payloadDigest: digest('x') }] })), /task approval pins exactly/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', entry({ operation: 'decision.dispose', disposition: 'answer', workflowDigest: undefined })), /undefined workflowDigest/);
  const answerWithoutList = { ...grant, entries: [{ entryId: 'answer', taskId: 'task-1', taskRevision: R1, operation: 'decision.dispose', disposition: 'answer', maxUses: 1, obligationId: 'decision-1', obligationVersion: 1, scopeDigest: digest('s'), optionSetDigest: digest('o') }] };
  assert.throws(() => validateAuthorityRecord('operatorGrant', answerWithoutList), /exact allowed answers/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, usage: { 'approve-1': 2 } }), /used beyond its limit/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, usage: { other: 1 } }), /unknown entry other/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, issuer: 'orchestrator' }), /issuer/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, issuedBy: { actor: 'orchestrator', commandId: 'x' } }), /issuedBy.actor/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, expiresAt: grant.notBefore }), /expire after it starts/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, status: 'revoked' }), /revoked grant records/);
  assert.throws(() => validateAuthorityRecord('operatorGrant', { ...grant, entries: [grant.entries[0], grant.entries[0]] }), /duplicate grant entry id/);
  assert.throws(() => validateAuthorityRecord('authorityUse', { ...s.directUse, grantId: 'grant-1' }), /direct operator use names none/);
});

test('decision lifecycle shapes and digests must agree', () => {
  const s = samples('project-1'), o = s.decisionObligation, d = s.decisionDisposition;
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, requiredAt: ['build', 'release'] }), /always holds merge and complete/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, scopeDigest: digest('other') }), /scope digest mismatch/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, optionSetDigest: digest('other') }), /option-set digest mismatch/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, owner: 'orchestrator' }), /owner/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, applicability: [{ taskId: 'task-1', revision: digest('r2'), state: 'pending' }] }), /retain its origin revision/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, status: 'resolved' }), /resolved decision names its disposition/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, activeDispositionId: 'disposition-1' }), /unresolved decision has no active disposition/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, applicability: [{ ...o.applicability[0], state: 'covered' }] }), /coverage must name the active disposition/);
  assert.throws(() => validateAuthorityRecord('decisionObligation', { ...o, status: 'superseded', activeDispositionId: 'd', applicability: [{ ...o.applicability[0], state: 'covered', dispositionId: 'd' }], supersededBy: ['decision-1'] }), /cannot supersede itself/);
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...d, cancellation: { scopeDigest: d.scopeDigest, reason: 'also cancel' } }), /carries exactly/);
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...d, kind: 'supersede', answer: undefined, supersession: { replacements: [] } }), /undefined answer/);
  const { answer, ...bare } = d;
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...bare, kind: 'supersede', supersession: { replacements: [] } }), /replacement decisions or an authorized scope removal/);
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...bare, kind: 'supersede', supersession: { replacements: ['decision-1'] } }), /cannot supersede itself/);
  assert.ok(validateAuthorityRecord('decisionDisposition', { ...bare, kind: 'supersede', supersession: { replacements: [], removedScope: 'The fictional export is out of scope.', revisedRevision: digest('r2') } }));
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...bare, kind: 'cancel', cancellation: { scopeDigest: digest('elsewhere'), reason: 'Cancel it' } }), /exact decision scope/);
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...d, status: 'inactive' }), /inactive disposition records/);
  assert.throws(() => validateAuthorityRecord('decisionReport', { ...s.decisionReport, choices: [...s.decisionReport.choices, { ...s.decisionReport.choices[0], behavior: 'changed' }] }), /duplicate report choice id/);
  assert.throws(() => validateAuthorityRecord('decisionReport', { ...s.decisionReport, completeness: 'complete' }), /completeness/);
  assert.throws(() => validateAuthorityRecord('decisionReport', { ...s.decisionReport, choices: [] }), /body digest mismatch/);
  assert.throws(() => validateAuthorityRecord('releaseReview', { ...s.releaseReview, dispositions: [{ ...s.releaseReview.dispositions[0], reportId: 'report-elsewhere' }] }), /outside its manifest/);
  assert.throws(() => validateAuthorityRecord('releaseReview', { ...s.releaseReview, dispositions: [{ ...s.releaseReview.dispositions[0], disposition: 'acknowledged' }] }), /disposition/);
});

test('writes need the migrated schema, keep immutable records immutable and compare-and-swap versions', async t => {
  const legacy = sandbox(t), s0 = samples(legacy.project.projectId);
  assert.throws(() => legacy.store.tx(() => putAuthorityRecord(legacy.store, 'decisionReport', s0.decisionReport)), /run the authority migration first/);
  const f = await migrated(t), s = samples(f.project.projectId, f.store.need('task', 'task-1').revision), store = f.store;
  store.tx(() => putAuthorityRecord(store, 'decisionReport', s.decisionReport));
  assert.equal(store.tx(() => putAuthorityRecord(store, 'decisionReport', clone(s.decisionReport))).id, 'report-1');
  const changed = { ...s.decisionReport, choices: [] }; changed.bodyDigest = reportBodyDigest(changed);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionReport', changed)), /immutable/);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionObligation', { ...s.decisionObligation, version: 2 })), /starts at version 1/);
  store.tx(() => putAuthorityRecord(store, 'decisionObligation', s.decisionObligation));
  const next = { ...s.decisionObligation, version: 2, updatedAt: LATER };
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionObligation', next)), /expected version undefined/);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionObligation', next, { expectedVersion: 2 })), /changed; expected version 2, found 1/);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionObligation', { ...next, version: 3 }, { expectedVersion: 1 })), /exactly one version/);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'decisionObligation', { ...next, question: 'A quietly different question?' }, { expectedVersion: 1 })), /only its versioned state/);
  store.tx(() => putAuthorityRecord(store, 'decisionObligation', next, { expectedVersion: 1 }));
  assert.equal(store.get('decisionObligation', 'decision-1').version, 2);
  assert.throws(() => store.tx(() => putAuthorityRecord(store, 'operatorGrant', { ...s.operatorGrant, projectId: 'another-project' })), /another project/);
});

test('audit fails closed on dangling references and supersession cycles', async t => {
  const f = await migrated(t), revision = f.store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision), store = f.store;
  assert.deepEqual(auditAuthorityRecords(store), []);
  // Raw writes bypass the validator, as corruption or a faulty restore would.
  store.put('decisionObligation', { ...s.decisionObligation, status: 'resolved', activeDispositionId: 'disposition-1', applicability: [{ taskId: 'task-1', revision, state: 'covered', dispositionId: 'disposition-1' }] });
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /active disposition disposition-1 missing/);
  store.put('decisionDisposition', s.decisionDisposition);
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /authority use use-direct is missing/);
  store.put('authorityUse', s.directUse);
  assert.deepEqual(auditAuthorityRecords(store), []);
  store.put('authorityUse', s.authorityUse);
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /grant entry grant-1\/approve-1 is missing/);
  store.put('operatorGrant', s.operatorGrant);
  store.put('decisionReport', { ...s.decisionReport, id: 'report-bad', previousReportId: 'report-missing', bodyDigest: reportBodyDigest({ ...s.decisionReport, previousReportId: 'report-missing' }) });
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /previous report report-missing is missing/);
  store.db.prepare("DELETE FROM records WHERE kind='decisionReport'").run();
  store.put('decisionObligation', { ...s.decisionObligation, applicability: [...s.decisionObligation.applicability, { taskId: 'task-1', revision: digest('never recorded'), state: 'pending' }] });
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /unrecorded revision/);
  const loop = (key, other) => {
    store.put('decisionObligation', { ...s.decisionObligation, id: key, status: 'superseded', activeDispositionId: `d-${key}`, supersededBy: [other], applicability: [{ taskId: 'task-1', revision, state: 'covered', dispositionId: `d-${key}` }] });
    const { answer, ...bare } = s.decisionDisposition;
    store.put('decisionDisposition', { ...bare, id: `d-${key}`, obligationId: key, kind: 'supersede', supersession: { replacements: [other] } });
  };
  store.db.prepare("DELETE FROM records WHERE kind='decisionObligation'").run();
  store.db.prepare("DELETE FROM records WHERE kind='decisionDisposition'").run();
  loop('decision-a', 'decision-b'); loop('decision-b', 'decision-a');
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /supersession cycle/);
  store.db.prepare("UPDATE records SET data='{not json' WHERE kind='decisionObligation' AND id='decision-a'").run();
  assert.match(auditAuthorityRecords(store).map(p => p.reason).join('\n'), /not JSON/);
});

test('migrated task.put appends immutable revision snapshots with request references and advances authority revision', async t => {
  const legacy = sandbox(t);
  legacy.command('task.put', { task: { id: 'task-1', title: 'Edited fictional feature', acceptance: ['Changed'] } });
  assert.equal(legacy.store.all('taskRevision').length, 0, 'schema 1 writes no ledger records');
  const f = await migrated(t), store = f.store, first = store.need('task', 'task-1').revision;
  const pid = f.project.projectId;
  assert.equal(taskRevisions(store, 'task-1').length, 1);
  const migratedRow = store.get('taskRevision', taskRevisionId(pid, 'task-1', first));
  assert.equal(migratedRow.historyIncomplete, true); assert.equal(migratedRow.previousRevision, null); assert.equal(migratedRow.requestCoverage, 'unknown'); assert.deepEqual(migratedRow.requestRefs, []);
  assert.equal(taskAuthorityRevision(store, 'task-1'), 1);
  // Labels and scheduling are outside the brief: no new revision, no new snapshot.
  f.command('task.label', { taskId: 'task-1', labels: ['fictional'] });
  f.command('task.put', { task: { id: 'task-1', title: 'Fictional feature', acceptance: ['Observed fixture behavior'] } });
  assert.equal(taskRevisions(store, 'task-1').length, 1); assert.equal(taskAuthorityRevision(store, 'task-1'), 1);
  const originalRequest = { origin: 'operator', source: 'Fictional planning call', date: '2026-11-12', text: 'Approved — go ahead and merge whatever you think is right.' };
  const edited = f.command('task.put', { task: { id: 'task-1', title: 'Fictional feature', acceptance: ['Observed fixture behavior'], originalRequest } });
  assert.equal(edited.status, 'completed');
  const second = store.need('task', 'task-1').revision, row = store.get('taskRevision', taskRevisionId(pid, 'task-1', second));
  assert.notEqual(second, first);
  assert.equal(row.previousRevision, first); assert.equal(row.recordedBy, 'task.put'); assert.equal(row.historyIncomplete, undefined);
  assert.equal(row.requestCoverage, 'recorded'); assert.deepEqual(row.requestRefs, [{ field: 'originalRequest', origin: 'operator', source: originalRequest.source, date: originalRequest.date, digest: digest(originalRequest), verbatim: true }]);
  assert.deepEqual(row.brief.originalRequest, originalRequest);
  assert.equal(taskAuthorityRevision(store, 'task-1'), 2);
  // Permission-sounding request text is provenance: it approves nothing and issues nothing.
  assert.notEqual(store.need('task', 'task-1').approvedRevision, second);
  for (const kind of ['operatorGrant', 'authorityUse', 'decisionDisposition']) assert.equal(store.all(kind).length, 0);
  // The first revision's snapshot is unchanged history.
  assert.deepEqual(store.get('taskRevision', taskRevisionId(pid, 'task-1', first)), migratedRow);
  // A rejected command rolls back its snapshot with the rest of its effects.
  const rejected = f.command('task.put', { expectedRevision: first, task: { id: 'task-1', title: 'Stale edit', acceptance: ['x'] } });
  assert.equal(rejected.status, 'rejected'); assert.equal(taskRevisions(store, 'task-1').length, 2);
  assert.deepEqual(auditAuthorityRecords(store), []);
});

test('a snapshot stores the brief as persisted and refuses an oversized brief', async t => {
  const f = await migrated(t), store = f.store;
  // A recurring brief may carry workflow: undefined; the stored digest must match after reload.
  const row = store.tx(() => recordTaskRevision(store, { taskId: 'task-r', revision: digest('recurring'), brief: { id: 'task-r', title: 'Fictional recurring', acceptance: ['Ran'], workflow: undefined }, recordedBy: 'recurring' }));
  assert.equal(Object.hasOwn(row.brief, 'workflow'), false);
  assert.ok(validateAuthorityRecord('taskRevision', store.get('taskRevision', row.id)));
  assert.throws(() => store.tx(() => recordTaskRevision(store, { taskId: 'task-big', revision: digest('big'), brief: { id: 'task-big', title: 'Big', acceptance: ['x'.repeat(300 * 1024)] }, recordedBy: 'task.put' })), /larger than/);
  const oversized = f.command('task.put', { task: { id: 'task-big', title: 'Big', acceptance: ['x'.repeat(300 * 1024)] } });
  assert.equal(oversized.status, 'rejected'); assert.equal(store.get('task', 'task-big'), undefined);
});

test('versioned writes follow one-way transitions: spent, revoked or inactive authority never comes back', async t => {
  const f = await migrated(t), store = f.store, revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  const put = (kind, record, expectedVersion) => store.tx(() => putAuthorityRecord(store, kind, record, { expectedVersion }));
  const revoked = { revokedAt: LATER, revocationCommandId: 'cmd-revoke' }, inactive = { inactiveReason: 'Revoked by the fictional operator.', inactiveAt: LATER };
  // A one-use grant entry, once consumed, cannot be refunded by rewriting its usage.
  put('operatorGrant', s.operatorGrant);
  put('operatorGrant', { ...s.operatorGrant, version: 2, usage: { 'approve-1': 1 } }, 1);
  assert.throws(() => put('operatorGrant', { ...s.operatorGrant, version: 3, usage: {} }, 2), /usage of entry approve-1 can only increase/);
  assert.throws(() => put('operatorGrant', { ...s.operatorGrant, version: 3, usage: { 'approve-1': 0 } }, 2), /can only increase/);
  assert.throws(() => put('operatorGrant', { ...s.operatorGrant, version: 3, usage: {}, status: 'revoked', ...revoked }, 2), /can only increase/);
  put('operatorGrant', { ...s.operatorGrant, version: 3, usage: { 'approve-1': 1 }, status: 'revoked', ...revoked }, 2);
  assert.throws(() => put('operatorGrant', { ...s.operatorGrant, version: 4, usage: { 'approve-1': 1 } }, 3), /revoked grant is final/);
  assert.deepEqual(store.get('operatorGrant', 'grant-1').usage, { 'approve-1': 1 });
  // An inactive authority use or disposition is history; it is never reactivated in place.
  put('authorityUse', s.directUse);
  put('authorityUse', { ...s.directUse, version: 2, status: 'inactive', ...inactive }, 1);
  assert.throws(() => put('authorityUse', { ...s.directUse, version: 3 }, 2), /never reactivated in place/);
  assert.throws(() => put('authorityUse', { ...s.directUse, version: 3, status: 'inactive', ...inactive, inactiveReason: 'Rewritten history.' }, 2), /never reactivated in place/);
  const use2 = { ...s.directUse, id: 'use-direct-2', commandId: 'cmd-answer-2' }; put('authorityUse', use2);
  const d = { ...s.decisionDisposition, authorityUseId: 'use-direct-2' };
  put('decisionDisposition', d);
  put('decisionDisposition', { ...d, version: 2, status: 'inactive', ...inactive }, 1);
  assert.throws(() => put('decisionDisposition', { ...d, version: 3 }, 2), /never reactivated in place: ratify or answer anew/);
  // A decision cannot name an inactive disposition, drop applicability, swap a settled answer or leave supersession.
  const o = s.decisionObligation, covered = id => [{ taskId: 'task-1', revision, state: 'covered', dispositionId: id }];
  put('decisionObligation', o);
  assert.throws(() => put('decisionObligation', { ...o, version: 2, status: 'resolved', activeDispositionId: 'disposition-1', applicability: covered('disposition-1') }, 1), /can only name an active disposition of its own/);
  const fresh = { ...d, id: 'disposition-2' }; put('decisionDisposition', fresh);
  put('decisionObligation', { ...o, version: 2, status: 'resolved', activeDispositionId: 'disposition-2', applicability: covered('disposition-2') }, 1);
  const other = { ...d, id: 'disposition-3', answer: { optionId: 'yaml', payloadDigest: o.options[1].payloadDigest } }; put('decisionDisposition', other);
  assert.throws(() => put('decisionObligation', { ...o, version: 3, status: 'resolved', activeDispositionId: 'disposition-3', applicability: covered('disposition-3') }, 2), /only by revocation back to unresolved/);
  const r2 = digest('fictional revision two');
  put('decisionObligation', { ...o, version: 3, applicability: [{ taskId: 'task-1', revision, state: 'pending' }, { taskId: 'task-1', revision: r2, state: 'pending' }] }, 2);
  assert.throws(() => put('decisionObligation', { ...o, version: 4, applicability: [{ taskId: 'task-1', revision, state: 'pending' }] }, 3), /applicability task-1@[a-f0-9]+ cannot be dropped/);
  // Release reviews and legacy inventory rows are one-way too.
  const reviewUse = { ...s.directUse, id: 'use-review', operation: 'release.review', disposition: 'review' }; put('authorityUse', reviewUse);
  const review = { ...s.releaseReview, authorityUseId: 'use-review' }; put('releaseReview', review);
  put('releaseReview', { ...review, version: 2, status: 'revoked', revokedAt: LATER }, 1);
  assert.throws(() => put('releaseReview', { ...review, version: 3 }, 2), /revoked review is final/);
  const subject = { integration: 'fictional-release' }, pid = f.project.projectId;
  const legacy = { schemaVersion: 1, id: digest({ kind: 'legacyAuthority', projectId: pid, item: 'release-integration', subject }), projectId: pid, migrationId: store.meta('authorityMigration').migrationId, item: 'release-integration', subject, classification: 'unqualified-release', status: 'held', reasons: ['A fictional release integration.'], version: 1, createdAt: LATER };
  put('legacyAuthority', legacy);
  assert.throws(() => put('legacyAuthority', { ...legacy, version: 2, status: 'retained' }, 1), /stays held until explicitly resolved/);
  const resolution = { commandId: 'cmd-ratify', kind: 'ratified', at: LATER };
  put('legacyAuthority', { ...legacy, version: 2, status: 'retained', resolution }, 1);
  assert.throws(() => put('legacyAuthority', { ...legacy, version: 3, status: 'held', resolution }, 2), /resolved legacy authority is final/);
  assert.throws(() => put('legacyAuthority', { ...legacy, version: 3, status: 'retained', resolution: { ...resolution, kind: 'rewritten' } }, 2), /resolved legacy authority is final/);
  // The authority revision only advances.
  const authority = store.get('taskAuthority', 'task-1');
  assert.throws(() => put('taskAuthority', { ...authority, lastChange: { cause: 'decision-open' } }, authority.authorityRevision), /exactly one version/);
  put('taskAuthority', { ...authority, authorityRevision: authority.authorityRevision + 1, updatedAt: LATER, lastChange: { cause: 'decision-open' } }, authority.authorityRevision);
});

test('the audit requires an active disposition to cover its decision exactly and every task revision reference to exist', async t => {
  const f = await migrated(t), store = f.store, revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  const reasons = () => auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n');
  const o = s.decisionObligation, d = s.decisionDisposition;
  const resolved = { ...o, version: 2, status: 'resolved', activeDispositionId: d.id, applicability: [{ taskId: 'task-1', revision, state: 'covered', dispositionId: d.id }] };
  store.put('authorityUse', s.directUse); store.put('decisionObligation', resolved); store.put('decisionDisposition', d);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // The reviewer's case: a resolved decision cleared by a disposition of another scope, option set and a nonexistent task revision.
  const ghost = digest('nonexistent revision');
  store.put('decisionDisposition', { ...d, scopeDigest: digest('another scope'), optionSetDigest: digest('another option set'), applicability: [{ taskId: 'task-ghost', revision: ghost }] });
  let found = reasons();
  assert.match(found, /covers a different scope/); assert.match(found, /answered a different option set/);
  assert.match(found, /applies to task-ghost@/); assert.match(found, /marked covered but its disposition does not apply/);
  assert.match(found, /applicability names unrecorded revision task-ghost@/);
  // An answer outside the options, or a disposition kind that does not match the status, does not clear it.
  store.put('decisionDisposition', { ...d, answer: { optionId: 'toml', payloadDigest: digest({ format: 'toml' }) } });
  assert.match(reasons(), /selects an answer outside the decision options/);
  store.put('decisionDisposition', d); store.put('decisionObligation', { ...resolved, status: 'canceled' });
  assert.match(reasons(), /a canceled decision cannot be cleared by a answer disposition/);
  store.put('decisionObligation', resolved);
  // Historical dispositions stay historical: an inactive one of an earlier option set is not a problem.
  const old = { ...d, id: 'disposition-old', authorityUseId: 'use-old', commandId: 'cmd-old', optionSetDigest: digest('earlier options'), answer: { optionId: 'xml', payloadDigest: digest('xml') }, status: 'inactive', inactiveReason: 'Options changed.', inactiveAt: LATER, version: 2 };
  store.put('authorityUse', { ...s.directUse, id: 'use-old', commandId: 'cmd-old', subjectDigest: subjectOf(old), consumptionKey: digest({ command: 'cmd-old' }), status: 'inactive', inactiveReason: 'Options changed.', inactiveAt: LATER, version: 2 });
  store.put('decisionDisposition', old);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // ...but an active disposition the decision does not name is not history.
  store.put('decisionDisposition', { ...d, id: 'disposition-stray' });
  assert.match(reasons(), /active disposition is not the one decision decision-1 names/);
  store.db.prepare("DELETE FROM records WHERE kind='decisionDisposition' AND id='disposition-stray'").run();
  // An active disposition resting on an inactive authority use is not clearance.
  store.put('authorityUse', { ...s.directUse, version: 2, status: 'inactive', inactiveReason: 'Revoked.', inactiveAt: LATER });
  assert.match(reasons(), /rests on inactive authority use use-direct/);
  store.put('authorityUse', s.directUse);
  // Reports, grants and release manifests must name recorded task revisions.
  const ghostReport = { ...s.decisionReport, id: 'report-ghost', taskId: 'task-ghost', taskRevision: ghost }; ghostReport.bodyDigest = reportBodyDigest(ghostReport);
  store.put('decisionReport', ghostReport);
  assert.match(reasons(), /report names unrecorded revision task-ghost@/);
  store.db.prepare("DELETE FROM records WHERE kind='decisionReport'").run();
  store.put('operatorGrant', { ...s.operatorGrant, entries: [{ ...s.operatorGrant.entries[0], taskRevision: ghost }] });
  assert.match(reasons(), /entry approve-1 names unrecorded revision task-1@/);
  // A grant use must bind what its entry permits and must have been counted in the grant's usage.
  store.put('operatorGrant', s.operatorGrant); store.put('authorityUse', s.authorityUse);
  assert.match(reasons(), /entry approve-1 records 0 use\(s\) but 1 authority use\(s\) cite it/);
  store.put('operatorGrant', { ...s.operatorGrant, usage: { 'approve-1': 1 } });
  store.put('authorityUse', { ...s.authorityUse, operation: 'decision.dispose', disposition: 'answer', grantVersion: 5 });
  found = reasons(); assert.match(found, /is not what grant entry grant-1\/approve-1 permits/); assert.match(found, /names grant version 5/);
  store.put('authorityUse', s.authorityUse);
  const manifest = { ...s.releaseReview.manifest, included: [{ taskId: 'task-1', revision: ghost }], reports: [] };
  store.put('authorityUse', { ...s.directUse, id: 'use-review', operation: 'release.review', disposition: 'review' });
  store.put('releaseReview', { ...s.releaseReview, authorityUseId: 'use-review', manifest, manifestDigest: digest(manifest), reportSetDigest: digest([]), dispositions: [] });
  assert.match(reasons(), /manifest names unrecorded revision task-1@/);
  store.put('releaseReview', { ...s.releaseReview, manifest, manifestDigest: digest(manifest), reportSetDigest: digest([]), dispositions: [] });
  assert.match(reasons(), /authorized decision.dispose, not a release review/);
});

// A resolved decision and the grant-backed answer that resolves it: a one-use answer
// entry pinned to the decision version, scope, options, revision and allowed answer,
// and the relayed answer recording the operator's words the orchestrator entered.
function grantedAnswer(store, s, revision) {
  const o = s.decisionObligation, d = s.decisionDisposition;
  const entry = { entryId: 'answer-1', taskId: 'task-1', taskRevision: revision, operation: 'decision.dispose', disposition: 'answer', maxUses: 1, obligationId: o.id, obligationVersion: 1, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, answers: [d.answer] };
  const grant = { ...s.operatorGrant, entries: [entry], usage: { 'answer-1': 1 } };
  const disposition = { ...d, authorityUseId: 'use-answer', relayedAnswerId: 'relay-1' };
  store.put('relayedAnswer', { schemaVersion: 1, id: 'relay-1', projectId: o.projectId, decisionId: o.id, decisionVersion: 1, taskId: 'task-1', taskRevision: revision, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, selected: d.answer, relayedBy: 'orchestrator', quote: 'Fictional operator: keep JSON.', channel: 'fictional chat', commandId: d.commandId, createdAt: d.createdAt, status: 'applied', version: 1, dispositionId: d.id });
  const use = { ...s.authorityUse, id: 'use-answer', entryId: 'answer-1', commandId: d.commandId, operation: 'decision.dispose', disposition: 'answer', subjectDigest: subjectOf(disposition) };
  const covered = (status, id = disposition.id) => ({ ...o, version: 2, status, activeDispositionId: id, applicability: [{ taskId: 'task-1', revision, state: 'covered', dispositionId: id }] });
  store.put('operatorGrant', grant); store.put('authorityUse', use); store.put('decisionDisposition', disposition); store.put('decisionObligation', covered('resolved'));
  return { o, entry, grant, use, disposition, covered };
}

test('a disposition must be the one its authority use and grant entry permit: kind, decision version, scope, options, revision and payload', async t => {
  const f = await migrated(t), store = f.store, revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  const reasons = () => auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n');
  const { o, entry, grant, use, disposition, covered } = grantedAnswer(store, s, revision);
  assert.deepEqual(auditAuthorityRecords(store), []);
  const withEntry = change => store.put('operatorGrant', { ...grant, entries: [{ ...entry, ...change }] });
  // The reviewer's case: a cancellation-only grant, a counted cancellation use, and an answer citing it.
  const { answers, ...bare } = entry, cancelEntry = { ...bare, entryId: 'cancel-1', disposition: 'cancel', payloadDigest: digest('fictional cancellation') };
  store.put('operatorGrant', { ...grant, entries: [cancelEntry], usage: { 'cancel-1': 1 } });
  store.put('authorityUse', { ...use, entryId: 'cancel-1', disposition: 'cancel' });
  let found = reasons();
  assert.match(found, /authority use use-answer permits cancel, not this answer disposition/);
  assert.match(found, /grant entry grant-1\/cancel-1 permits decision.dispose\/cancel, not a answer disposition/);
  const restoreRefused = name => {
    backupProject(f.stateDir, join(f.base, name));
    assert.throws(() => restoreProject(join(f.base, name), join(f.base, `${name}-restored`)), /restore refused: decision-authority records need repair/);
    assert.equal(existsSync(join(f.base, `${name}-restored`)), false);
  };
  restoreRefused('cancel-authorizes-answer');
  store.put('operatorGrant', grant); store.put('authorityUse', use);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // Each pin of the entry must be what the disposition recorded.
  withEntry({ obligationVersion: 2 }); assert.match(reasons(), /pins decision decision-1 version 2, not decision-1 version 1/);
  withEntry({ scopeDigest: digest('another scope') }); assert.match(reasons(), /grant entry grant-1\/answer-1 pins a different scope than the disposition/);
  withEntry({ optionSetDigest: digest('another option set') }); assert.match(reasons(), /grant entry grant-1\/answer-1 pins a different option set than the disposition/);
  withEntry({ taskRevision: digest('another revision') }); assert.match(reasons(), /pins task-1@[a-f0-9]+; it cannot authorize task-1@/);
  withEntry({ answers: [{ optionId: 'yaml', payloadDigest: o.options[1].payloadDigest }] }); assert.match(reasons(), /grant entry grant-1\/answer-1 does not permit answer json/);
  store.put('operatorGrant', grant);
  // The use belongs to the disposition's own command, and to the grant's validity interval.
  store.put('authorityUse', { ...use, commandId: 'cmd-other' }); assert.match(reasons(), /use-answer was recorded by command cmd-other, not cmd-answer/);
  store.put('authorityUse', { ...use, createdAt: LATER }); assert.match(reasons(), /used grant grant-1 outside its validity interval/);
  store.put('authorityUse', use);
  // A direct operator use is tied to its disposition kind too. (A direct answer relays nothing.)
  const { relayedAnswerId: _relay, ...unrelayed } = disposition;
  store.db.prepare("DELETE FROM records WHERE kind='relayedAnswer' AND id=?").run(disposition.relayedAnswerId);
  store.put('authorityUse', { ...s.directUse, disposition: 'cancel' }); store.put('decisionDisposition', { ...unrelayed, authorityUseId: 'use-direct' });
  assert.match(reasons(), /authority use use-direct permits cancel, not this answer disposition/);
  store.put('authorityUse', s.directUse); assert.deepEqual(auditAuthorityRecords(store), []);
  // Cancellation: the entry pins the exact cancellation payload (its reason is the operator's, written in the grant).
  const { answer, ...plain } = unrelayed;
  const cancel = { ...plain, kind: 'cancel', cancellation: { scopeDigest: o.scopeDigest, reason: 'The fictional feature is dropped.' } };
  store.put('decisionDisposition', cancel); store.put('decisionObligation', covered('canceled'));
  store.put('operatorGrant', { ...grant, entries: [{ ...cancelEntry, entryId: 'answer-1', payloadDigest: dispositionPayloadDigest(cancel) }] });
  store.put('authorityUse', { ...use, disposition: 'cancel', subjectDigest: subjectOf(cancel) });
  assert.deepEqual(auditAuthorityRecords(store), []);
  store.put('decisionDisposition', { ...cancel, cancellation: { ...cancel.cancellation, reason: 'A different cancellation.' } });
  assert.match(reasons(), /pins a different cancellation payload than the disposition/);
});

test('direct operator ratification restores only an inactive answer of the same decision, and is never granted', async t => {
  const f = await migrated(t), store = f.store, revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  const reasons = () => auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n');
  const { use, disposition, covered } = grantedAnswer(store, s, revision);
  // The grant-backed answer went inactive (its grant expired); the operator ratifies the same answer.
  const inactive = { inactiveReason: 'The fictional grant expired.', inactiveAt: LATER };
  store.put('authorityUse', { ...use, version: 2, status: 'inactive', ...inactive });
  store.put('decisionDisposition', { ...disposition, version: 2, status: 'inactive', ...inactive });
  // Ratification is the operator's own direct answer: it cites no relay.
  const { relayedAnswerId: _relay, ...direct } = disposition;
  const ratified = { ...direct, id: 'disposition-ratified', authorityUseId: 'use-ratify', commandId: 'cmd-ratify', createdAt: LATER, ratifiesDispositionId: disposition.id };
  const ratifyUse = { ...s.directUse, id: 'use-ratify', commandId: 'cmd-ratify', operation: 'decision.ratify', disposition: 'ratify', createdAt: LATER, subjectDigest: subjectOf(ratified) };
  store.put('authorityUse', ratifyUse); store.put('decisionDisposition', ratified); store.put('decisionObligation', covered('resolved', ratified.id));
  assert.deepEqual(auditAuthorityRecords(store), []);
  // Ratification must name the inactive answer it restores.
  const { ratifiesDispositionId, ...unnamed } = ratified;
  store.put('decisionDisposition', unnamed);
  assert.match(reasons(), /ratification names no inactive disposition it restores/);
  store.put('decisionDisposition', ratified);
  // Ratification cannot change the answer, or the revisions it applies to, or cancel.
  store.put('decisionDisposition', { ...ratified, answer: { optionId: 'yaml', payloadDigest: s.decisionObligation.options[1].payloadDigest } });
  assert.match(reasons(), /does not repeat an inactive answer of decision decision-1 with the same answer, scope, options and revisions/);
  store.put('decisionDisposition', { ...ratified, applicability: [{ taskId: 'task-1', revision: digest('a later fictional brief') }] });
  assert.match(reasons(), /does not repeat an inactive answer of decision decision-1 with the same answer, scope, options and revisions/);
  store.put('decisionDisposition', ratified);
  // An inactive answer is ratified once; a second ratification of it is refused.
  store.put('authorityUse', { ...ratifyUse, id: 'use-ratify-2', commandId: 'cmd-ratify-2', consumptionKey: digest({ command: 'cmd-ratify-2' }), status: 'inactive', inactiveReason: 'Superseded.', inactiveAt: LATER, version: 2 });
  store.put('decisionDisposition', { ...ratified, id: 'disposition-ratified-2', authorityUseId: 'use-ratify-2', commandId: 'cmd-ratify-2', status: 'inactive', inactiveReason: 'Superseded.', inactiveAt: LATER, version: 2 });
  assert.match(reasons(), /is ratified by 2 dispositions/);
  store.db.prepare("DELETE FROM records WHERE kind='decisionDisposition' AND id='disposition-ratified-2'").run();
  store.db.prepare("DELETE FROM records WHERE kind='authorityUse' AND id='use-ratify-2'").run();
  assert.deepEqual(auditAuthorityRecords(store), []);
  // Two inactive answers ratifying each other form a cycle with no original answer.
  const loop = (id, of, use) => ({ ...ratified, id, ratifiesDispositionId: of, authorityUseId: use, commandId: `cmd-${use}`, status: 'inactive', inactiveReason: 'Fictional loop.', inactiveAt: LATER, version: 2 });
  for (const use of ['loop-a', 'loop-b']) store.put('authorityUse', { ...ratifyUse, id: use, commandId: `cmd-${use}`, consumptionKey: digest({ command: use }), status: 'inactive', inactiveReason: 'Fictional loop.', inactiveAt: LATER, version: 2 });
  store.put('decisionDisposition', loop('disposition-loop-a', 'disposition-loop-b', 'loop-a')); store.put('decisionDisposition', loop('disposition-loop-b', 'disposition-loop-a', 'loop-b'));
  assert.match(reasons(), /ratification chain does not end at an original answer/);
  for (const [kind, id] of [['decisionDisposition', 'disposition-loop-a'], ['decisionDisposition', 'disposition-loop-b'], ['authorityUse', 'loop-a'], ['authorityUse', 'loop-b']]) store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // A ratification marker is only valid on an answer.
  const { answer, ...plain } = unnamed;
  assert.throws(() => validateAuthorityRecord('decisionDisposition', { ...plain, kind: 'cancel', cancellation: { scopeDigest: ratified.scopeDigest, reason: 'x' }, ratifiesDispositionId: disposition.id }), /only an answer can ratify/);
  store.put('decisionDisposition', { ...plain, kind: 'cancel', cancellation: { scopeDigest: ratified.scopeDigest, reason: 'Cancel by ratifying.' } }); store.put('decisionObligation', covered('canceled', ratified.id));
  assert.match(reasons(), /ratification restores an answer; it cannot authorize a cancel disposition/);
  // A ratification use is direct operator authority with the ratify disposition only.
  assert.throws(() => validateAuthorityRecord('authorityUse', { ...ratifyUse, source: 'grant', grantId: 'grant-1', entryId: 'answer-1', grantVersion: 1 }), /ratification is direct operator authority only/);
  assert.throws(() => validateAuthorityRecord('authorityUse', { ...ratifyUse, disposition: 'answer' }), /cannot permit answer/);
  assert.throws(() => validateAuthorityRecord('authorityUse', { ...s.directUse, disposition: 'approve' }), /for decision.dispose cannot permit approve/);
});

test('supersession by scope removal needs a recorded later revision of the decision task; decision grant entries name the decision exactly', async t => {
  const f = await migrated(t), store = f.store, origin = store.need('task', 'task-1').revision, s = samples(f.project.projectId, origin);
  const reasons = () => auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n');
  const o = s.decisionObligation, { answer, ...plain } = s.decisionDisposition;
  const superseded = { ...o, version: 2, status: 'superseded', activeDispositionId: plain.id, applicability: [{ taskId: 'task-1', revision: origin, state: 'covered', dispositionId: plain.id }] };
  const removal = revisedRevision => ({ ...plain, kind: 'supersede', supersession: { replacements: [], removedScope: 'The fictional storage option is removed from the brief.', revisedRevision } });
  store.put('authorityUse', { ...s.directUse, disposition: 'supersede' }); store.put('decisionObligation', superseded);
  // The reviewer's case: no replacements, a removed scope and a fabricated revision.
  store.put('decisionDisposition', removal(digest('fabricated revised brief')));
  assert.match(reasons(), /supersession names revised revision task-1@[a-f0-9]+, which has no task revision snapshot/);
  // The origin revision is not a revised brief.
  store.put('decisionDisposition', removal(origin));
  assert.match(reasons(), /is not a later revision of origin/);
  // Another task's recorded revision is not this decision's revised brief.
  assert.equal(f.command('task.put', { task: { id: 'task-2', title: 'Another fictional task', acceptance: ['Done'] } }).status, 'completed');
  store.put('decisionDisposition', removal(store.need('task', 'task-2').revision));
  assert.match(reasons(), /supersession names revised revision task-1@[a-f0-9]+, which has no task revision snapshot/);
  // A recorded revision of the same task that follows the origin is valid.
  assert.equal(f.command('task.put', { task: { id: 'task-1', title: 'Fictional feature without the storage option', acceptance: ['Observed fixture behavior'] } }).status, 'completed');
  const revised = store.need('task', 'task-1').revision; assert.notEqual(revised, origin);
  store.put('decisionDisposition', removal(revised)); store.put('authorityUse', { ...s.directUse, disposition: 'supersede', subjectDigest: subjectOf(removal(revised)) });
  assert.deepEqual(auditAuthorityRecords(store), []);
  // A decision grant entry names an existing decision with its pins.
  store.put('decisionObligation', o); store.db.prepare("DELETE FROM records WHERE kind='decisionDisposition'").run();
  assert.deepEqual(auditAuthorityRecords(store), []);
  const entry = { entryId: 'answer-1', taskId: 'task-1', taskRevision: origin, operation: 'decision.dispose', disposition: 'answer', maxUses: 1, obligationId: o.id, obligationVersion: 1, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, answers: [s.decisionDisposition.answer] };
  const withEntry = change => store.put('operatorGrant', { ...s.operatorGrant, entries: [{ ...entry, ...change }] });
  withEntry({}); assert.deepEqual(auditAuthorityRecords(store), []);
  withEntry({ obligationId: 'decision-ghost' }); assert.match(reasons(), /entry answer-1 names missing decision decision-ghost/);
  withEntry({ obligationVersion: 3 }); assert.match(reasons(), /pins decision decision-1 version 3, later than its version 1/);
  withEntry({ scopeDigest: digest('another scope') }); assert.match(reasons(), /entry answer-1 pins a different scope than decision decision-1/);
  withEntry({ optionSetDigest: digest('another option set') }); assert.match(reasons(), /entry answer-1 pins a different option set than decision decision-1/);
  withEntry({ answers: [{ optionId: 'toml', payloadDigest: digest({ format: 'toml' }) }] }); assert.match(reasons(), /allows answer toml, which is not an option of decision decision-1/);
  withEntry({ taskRevision: revised }); assert.match(reasons(), /names task-1@[a-f0-9]+, which decision decision-1 does not apply to/);
});

test('one counted authority use authorizes exactly one disposition, including inactive history', async t => {
  const f = await migrated(t), store = f.store, revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  const { disposition } = grantedAnswer(store, s, revision);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // The one-use grant entry allows JSON or YAML; usage is 1. A second disposition citing the same use and command
  // (an inactive JSON answer next to the active one) must not pass as covered by that single use.
  store.put('decisionDisposition', { ...disposition, id: 'disposition-twin', answer: { optionId: 'yaml', payloadDigest: s.decisionObligation.options[1].payloadDigest }, status: 'inactive', inactiveReason: 'Fictional replay.', inactiveAt: LATER, version: 2 });
  assert.match(auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n'), /authorizes 2 dispositions \(.*disposition-twin.*\); one use authorizes exactly one/);
});
