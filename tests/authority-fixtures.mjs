// Fictional decision-authority fixtures shared by the record and migration tests.
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { approvalSubject, authoritySubjectDigest, dispositionSubject, optionSetDigest, reportBodyDigest, scopeDigest } from '../starter/factory/core/decision-authority.mjs';
import { applyAuthorityMigration } from '../starter/factory/operations/authority-migration.mjs';

export const T = '2026-11-13T15:00:00.000Z', LATER = '2026-11-14T15:00:00.000Z';
export const R1 = digest('fictional revision one'), WF = digest('fictional workflow');
// One valid record of every kind, for a fictional project.
export function samples(projectId, revision = R1) {
  const scope = { taskId: 'task-1', choiceId: 'storage-format' };
  const options = [{ id: 'json', label: 'Keep the fictional JSON file', payloadDigest: digest({ format: 'json' }) }, { id: 'yaml', label: 'Switch to fictional YAML', payloadDigest: digest({ format: 'yaml' }) }];
  const decisionObligation = { schemaVersion: 1, id: 'decision-1', projectId, taskId: 'task-1', originRevision: revision, version: 1, owner: 'operator', source: { kind: 'operator' }, question: 'Which storage format should the fictional feature use?', scope, scopeDigest: scopeDigest(scope), options, optionSetDigest: optionSetDigest(options), requiredAt: ['build', 'merge', 'complete'], applicability: [{ taskId: 'task-1', revision, state: 'pending' }], status: 'unresolved', activeDispositionId: null, createdAt: T, updatedAt: T };
  const operatorGrant = { schemaVersion: 1, id: 'grant-1', projectId, issuer: 'operator', issuedBy: { actor: 'operator', commandId: 'cmd-issue' }, grantee: 'orchestrator', notBefore: T, expiresAt: LATER, entries: [{ entryId: 'approve-1', taskId: 'task-1', taskRevision: revision, operation: 'task.approve', disposition: 'approve', maxUses: 1, workflowDigest: WF }], createdAt: T, version: 1, status: 'active', usage: {} };
  const authorityUse = { schemaVersion: 1, id: 'use-1', projectId, source: 'grant', grantId: 'grant-1', entryId: 'approve-1', grantVersion: 1, commandId: 'cmd-approve', operation: 'task.approve', subjectDigest: authoritySubjectDigest(approvalSubject({ taskId: 'task-1', taskRevision: revision, workflowDigest: WF })), disposition: 'approve', consumptionKey: digest({ grant: 'grant-1', entry: 'approve-1', use: 1 }), derived: [], createdAt: T, status: 'active', version: 1 };
  const decisionDisposition = { schemaVersion: 1, id: 'disposition-1', projectId, obligationId: 'decision-1', obligationVersion: 1, applicability: [{ taskId: 'task-1', revision }], scopeDigest: decisionObligation.scopeDigest, optionSetDigest: decisionObligation.optionSetDigest, kind: 'answer', answer: { optionId: 'json', payloadDigest: options[0].payloadDigest }, rationale: 'The fictional readers already parse JSON.', authorityUseId: 'use-direct', commandId: 'cmd-answer', createdAt: T, status: 'active', version: 1 };
  const directUse = { schemaVersion: 1, id: 'use-direct', projectId, source: 'direct-operator', commandId: 'cmd-answer', operation: 'decision.dispose', subjectDigest: authoritySubjectDigest(dispositionSubject(decisionDisposition)), disposition: 'answer', consumptionKey: digest({ command: 'cmd-answer' }), derived: [], createdAt: T, status: 'active', version: 1 };
  const decisionReport = { schemaVersion: 1, id: 'report-1', projectId, taskId: 'task-1', taskRevision: revision, reportVersion: 1, previousReportId: null, producer: { flowId: 'flow-1', attemptId: 'attempt-1', step: 'build' }, choices: [{ localId: 'label-text', title: 'Button label', behavior: 'Shows “Save draft”', rationale: 'Matches the fictional style guide.', scope: 'Editor toolbar', owner: 'collected' }], completeness: 'declared', reportSchemaVersion: 1, createdAt: T };
  decisionReport.bodyDigest = reportBodyDigest(decisionReport);
  const manifest = { repository: 'example/fictional', target: 'main', candidateDigest: digest('candidate'), included: [{ taskId: 'task-1', revision }], reports: [{ reportId: 'report-1', reportVersion: 1, bodyDigest: decisionReport.bodyDigest }] };
  const releaseReview = { schemaVersion: 1, id: 'review-1', projectId, manifest, manifestDigest: digest(manifest), reportSetDigest: digest(manifest.reports), dispositions: [{ reportId: 'report-1', choiceId: 'label-text', disposition: 'accept', rationale: 'Reviewed the fictional label.' }], authorityUseId: 'use-direct', commandId: 'cmd-review', createdAt: T, status: 'active', version: 1 };
  return { decisionObligation, operatorGrant, authorityUse, directUse, decisionDisposition, decisionReport, releaseReview };
}
export async function migrated(t) {
  const f = sandbox(t);
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'pre-migration-backup') });
  return f;
}
