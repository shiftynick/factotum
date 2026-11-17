import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from '../core/store.mjs';
import { assert, atomicJSON, digest, note, now, uid } from '../core/contracts.mjs';
import { assertAttemptQuiescent } from '../core/project.mjs';
import { Engine } from '../core/engine.mjs';
import { createGitHub } from '../adapters/github/index.mjs';
import { reconcileIntegrationAction } from './integrations.mjs';

// Read existing remote effects only. This function never repeats the write whose
// response was lost and never invents provider output or filesystem outcomes.
export async function reconcileAttempt(stateDir, attemptId, { reason, transport } = {}) {
  note(reason);
  const store = new Store(stateDir);
  try {
    const attempt = store.need('attempt', attemptId), flow = store.need('flow', attempt.flowId);
    if (attempt.settledAt) return { attemptId, status: attempt.status, alreadySettled: true };
    assert(attempt.status === 'uncertain' && flow.attemptId === attemptId, 'owned uncertain attempt required');
    assert(flow.stopRequested && flow.state === 'stopped', 'uncertain flow must remain stopped during reconciliation');
    assert(digest(attempt.intent) === attempt.intentDigest, 'retained intent digest mismatch');
    const { intentDigest: fileIntentDigest, ...fileIntent } = JSON.parse(readFileSync(join(stateDir, 'attempts', attemptId, 'intent.json'), 'utf8'));
    assert(fileIntentDigest === attempt.intentDigest && digest(fileIntent) === attempt.intentDigest, 'retained intent file differs from canonical intent');
    assertAttemptQuiescent(store, attempt);
    const a = attempt.intent.action;
    assert(a && ['forge.publish','forge.merge','forge.closeTask','integration.run'].includes(a.operation), 'this action needs independent operator inspection; no typed success reconciler exists');
    assert(attempt.intent.attemptId === attemptId && attempt.intent.flowId === flow.id && attempt.intent.projectId === store.meta('project').projectId && a.projectId === attempt.intent.projectId && a.flowId === flow.id, 'retained reconciliation identity mismatch');
    const forge = createGitHub({ repository: a.config.repository.slug, account: a.config.repository.account, hostname: a.config.repository.hostname, ghPath: a.config.repository.ghPath, issueProfile:a.config.repository.issueProfile, transport });
    let result;
    if (a.operation === 'integration.run') result=await reconcileIntegrationAction(attempt.intent);
    else if (a.operation === 'forge.merge') {
      const pr = await forge.readPR(a.results.publish.number);
      assert(pr.merged && pr.head === a.mergeAuthorization.identity.head && pr.mergeCommit, 'remote merge is not proven for the authorized head');
      result = { route: 'merged', merged: true, sha: pr.mergeCommit, expectedHead: pr.head, expectedBase: a.results.integrate.base, outputIdentity: a.mergeAuthorization.identity, reconciled: true };
    } else if (a.operation === 'forge.publish') {
      const published = await forge.lookupPublication({ branch: a.workspace.branch, operationId: `${a.projectId}:${a.flowId}:pr` });
      assert(published, 'no matching remote publication; no replacement write was attempted');
      const pr = await forge.readPR(published.number);
      assert(pr.state === 'open' && !pr.merged && pr.head === attempt.intent.inputIdentity.head && pr.headBranch === a.workspace.branch && pr.baseBranch === (a.target ?? a.config.repository.target), 'published candidate differs from the retained intent');
      result = { route: 'published', number: pr.number, url: pr.url, head: pr.head, branch: pr.headBranch, reconciled: true, ...(a.config.repository.issueProfile?.lifecycle?{obligations:[{id:`lifecycle:${attempt.id}:publication`,title:'Inspect configured lifecycle synchronization after reconciled publication',status:'pending',owner:'operator',requiresAuthorization:true,evidence:'The PR is proven; its separately configured issue labels/comment were not proven by this lookup.'}]}:{}) };
    } else {
      const task = await forge.readTask(a.task.source.issue);
      assert(task.state === 'closed' && task.revision === a.task.source.revision, 'unchanged source task closure is not proven');
      result = { route: 'closed', obligations: [{ id: `${flow.id}:close-task`, title: 'Source task closure', status: 'passed', evidence: `issue:${task.number}`, owner: 'operator' }], reconciled: true };
    }
    assertAttemptQuiescent(store, attempt);
    const proof = { id: uid(), attemptId, intentDigest: attempt.intentDigest, repository: a.config.repository.slug, operation: a.operation, actor: 'operator', reason, observedAt: now(), result };
    const proofPath = join(stateDir, 'reconciliations', `${proof.id}.json`);
    atomicJSON(proofPath, proof);
    store.tx(() => {
      const current = store.need('attempt', attemptId);
      const currentFlow = store.need('flow', flow.id);
      assert(current.status === 'uncertain' && !current.settledAt && current.intentDigest === attempt.intentDigest && digest(current.intent) === attempt.intentDigest && currentFlow.attemptId === attemptId && currentFlow.stopRequested && currentFlow.state === 'stopped', 'attempt changed during external inspection');
      store.put('reconciliation', { ...proof, proofDigest: digest(proof) });
      store.event('attempt.external-observation', { attemptId, reconciliationId: proof.id, actor: 'operator', reason });
    });
    new Engine(store).settle(flow.id, attempt, { version: 1, attemptId, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, source: 'read-only-external-reconciliation', reconciliationId: proof.id, actionResult: result });
    return { attemptId, status: store.need('attempt', attemptId).status, reconciliationId: proof.id, flowStopped: store.need('flow', flow.id).stopRequested, next: store.need('flow', flow.id).resumeStep };
  } finally { store.close(); }
}
