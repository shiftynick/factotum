// Plans 7/8 slice C: exact stored operator grants, transactional consumption, the
// delegation split, authority references in the command digest, revocation and
// expiry, normalized config-authority protection and relayed answers. Fictional
// fixtures, real command paths (executeCommand, the project service, the console
// command endpoint and the CLI), the real engine and a fake merge adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.mjs';
import { migrated } from './authority-fixtures.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { executeCommand, handshake, snapshot, taskView } from '../starter/factory/core/project.mjs';
import { auditAuthorityRecords, authoritySubjectDigest, dispositionSubject } from '../starter/factory/core/decision-authority.mjs';
import { decisionHolds } from '../starter/factory/core/decisions.mjs';
import { authorityPolicy } from '../starter/factory/core/authority-policy.mjs';
import { cancellationPayloadDigest } from '../starter/factory/core/grants.mjs';
import { startProjectService, collection } from '../starter/factory/service/project-service.mjs';
import { startConsole } from '../starter/factory/console/console.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
const refused = (receipt, pattern) => { assert.equal(receipt.status, 'rejected', `expected a refusal matching ${pattern}`); assert.match(receipt.error, pattern); return receipt; };
const instruction = { principal: 'operator', instruction: 'Fictional operator: go ahead with the agreed tasks.' };
// What the orchestrator enters on the operator's behalf: their words verbatim and where they were said.
const relay = { quote: 'Fictional operator: JSON is fine.', channel: 'fictional chat' };
const as = (f, operation, payload, { actor = 'orchestrator', onBehalfOf, authority, commandId = uid() } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId, operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}), ...(authority ? { authority } : {}) });
const later = (ms = 3600000) => new Date(Date.now() + ms).toISOString();
const rev = (f, taskId = 'task-1') => f.store.need('task', taskId).revision;
const sound = f => assert.deepEqual(auditAuthorityRecords(f.store), []);
const grantOf = (f, grantId) => f.store.need('operatorGrant', grantId);
const ref = (f, grantId, entryId) => ({ grantId, entryId, expectedVersion: grantOf(f, grantId).version });
const usage = (f, grantId) => grantOf(f, grantId).usage;
const grantUses = (f, grantId) => f.store.all('authorityUse').filter(u => u.grantId === grantId);
// The pins taskView shows before issue are exactly what an approval entry needs.
const approveEntry = (f, taskId = 'task-1', extra = {}) => { const pins = taskView(f.store, f.store.need('task', taskId)).grantPins; return { entryId: `approve-${taskId}`, operation: 'task.approve', disposition: 'approve', taskId, taskRevision: pins.taskRevision, workflowDigest: pins.workflowDigest, ...extra }; };
const decision = (f, decisionId) => f.store.need('decisionObligation', decisionId);
const answerEntry = (f, decisionId, optionIds = ['json'], extra = {}) => { const o = decision(f, decisionId); return { entryId: `answer-${decisionId}`, operation: 'decision.dispose', disposition: 'answer', taskId: o.taskId, taskRevision: rev(f, o.taskId), obligationId: o.id, obligationVersion: o.version, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, answers: o.options.filter(x => optionIds.includes(x.id)).map(x => ({ optionId: x.id, payloadDigest: x.payloadDigest })), ...extra }; };
const issue = (f, grantId, entries, extra = {}) => ok(f.command('grant.issue', { grantId, expiresAt: later(), entries, ...extra }));
const open = (f, decisionId, extra = {}) => ok(f.command('decision.open', { decisionId, taskId: 'task-1', expectedRevision: rev(f), question: `Which storage format should fictional ${decisionId} use?`, choiceId: `choice-${decisionId}`, options: [{ id: 'json', label: 'Keep the fictional JSON file' }, { id: 'yaml', label: 'Switch to fictional YAML' }], ...extra }));
const edit = (f, changes, taskId = 'task-1') => ok(f.command('task.put', { task: { id: taskId, title: 'Fictional feature', acceptance: ['Observed fixture behavior'], ...changes } }));
const ends = { done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } };
const useWorkflow = (f, nodes) => { const workflow = { version: 1, start: Object.keys(nodes)[0], nodes: { ...nodes, ...ends } }; f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); };
const shipWorkflow = f => useWorkflow(f, { ship: { kind: 'effect', argv: [process.execPath, '-e', '0'], timeoutMs: 8000, next: 'done', onFailure: 'failed' } });
// The prepared intent of the latest attempt, relabeled as a fake forge.merge whose result is a merged candidate.
function labelFakeMerge(f, delayMs) {
  const attempt = f.store.all('attempt').at(-1), dir = join(f.stateDir, 'attempts', attempt.id);
  const script = `setTimeout(()=>{const fs=require('fs');const i=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'intent.json'))},'utf8'));fs.writeFileSync(${JSON.stringify(join(dir, 'action-result.json'))},JSON.stringify({attemptId:i.attemptId,intentDigest:i.intentDigest,route:'merged',merged:true,sha:'${'b'.repeat(40)}'}))},${delayMs})`;
  const intent = { ...attempt.intent, argv: [process.execPath, '-e', script], action: { operation: 'forge.merge' } };
  rmSync(join(dir, 'intent.json'), { force: true });
  f.store.put('attempt', { ...attempt, intent, intentDigest: digest(intent) });
  return { attempt: f.store.need('attempt', attempt.id), dir };
}
// Move the clock past a grant's expiry for the engine and command paths, then restore it.
async function afterExpiry(t, grant, fn) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(grant.expiresAt) + 1000 });
  try { return await fn(); } finally { t.mock.timers.reset(); }
}

test('a schema-1 project is unchanged: no grant commands, no authority references, delegated approval as before', async t => {
  const f = sandbox(t);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [] }), /migrated authority ledger/);
  refused(f.command('grant.revoke', { grantId: 'grant-x', expectedVersion: 1, reason: 'r' }), /migrated authority ledger/);
  assert.throws(() => as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction, authority: { grantId: 'grant-x', entryId: 'e', expectedVersion: 1 } }), /migrated authority ledger/);
  // Operational delegation still approves on an unmigrated project, exactly as before.
  ok(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction }));
  assert.equal(f.store.need('task', 'task-1').approvalAuthority, undefined);
  assert.equal(Object.hasOwn(snapshot(f.store), 'grants'), false);
  assert.equal(Object.hasOwn(taskView(f.store, f.store.need('task', 'task-1')), 'grantPins'), false);
  assert.ok(!handshake(f.store).capabilities.includes('operatorGrants.v1'));
});

test('only the operator, directly, issues and revokes grants; entries are checked exactly against current state', async t => {
  const f = await migrated(t);
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Done'] } }));
  const entry = approveEntry(f);
  for (const options of [{}, { onBehalfOf: instruction }]) refused(as(f, 'grant.issue', { expiresAt: later(), entries: [entry] }, options), /grant.issue needs the operator directly/);
  // grant.issue cannot be delegated, reached through a maintenance job, or authorized by another grant.
  refused(f.command('settings.update', { changes: { 'policy.delegatedOperations': ['answer', 'grant.issue'] }, note: 'Fictional: try to delegate grants' }), /grant.issue cannot be delegated/);
  refused(as(f, 'job.enqueue', { operation: 'grant.issue', payload: { expiresAt: later(), entries: [entry] }, note: 'Fictional laundering' }, { onBehalfOf: instruction }), /unsupported maintenance operation/);
  assert.throws(() => as(f, 'grant.issue', { expiresAt: later(), entries: [entry] }, { actor: 'operator', authority: { grantId: 'g', entryId: 'e', expectedVersion: 1 } }), /grant.issue cannot use grant authority/);
  const before = f.store.all('operatorGrant').length;
  // Every pin is exact and current.
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...entry, taskRevision: digest('a stale fictional brief') }] }), /a grant pins the exact current revision/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...entry, workflowDigest: digest('another workflow') }] }), /selects workflow/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...entry, taskId: 'task-ghost' }] }), /does not exist/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...entry, operation: 'plan.consent', disposition: 'consent' }] }), /plan.consent cannot be granted/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...entry, allTasks: true }] }), /unknown field allTasks/);
  refused(f.command('grant.issue', { entries: [entry] }), /expiresAt is required/);
  refused(f.command('grant.issue', { expiresAt: later(40 * 86400000), entries: [entry] }), /at most 30 days/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [] }), /1-100 exact entries/);
  assert.equal(f.store.all('operatorGrant').length, before, 'refused issues write nothing');
  const g = issue(f, 'grant-batch', [entry, approveEntry(f, 'task-2')], { reason: 'Fictional: these two briefs are agreed' });
  assert.equal(g.issuedBy.actor, 'operator'); assert.equal(g.grantee, 'orchestrator'); assert.deepEqual(g.usage, {}); assert.equal(g.entries[0].maxUses, 1);
  refused(f.command('grant.issue', { grantId: 'grant-batch', expiresAt: later(), entries: [entry] }), /already exists; a changed scope needs a new grant/);
  for (const options of [{}, { onBehalfOf: instruction }]) refused(as(f, 'grant.revoke', { grantId: 'grant-batch', expectedVersion: 1, reason: 'Fictional' }, options), /grant.revoke needs the operator directly/);
  refused(f.command('grant.revoke', { grantId: 'grant-batch', expectedVersion: 2, reason: 'Fictional' }), /changed \(version 1, expected 2\)/);
  assert.equal(grantOf(f, 'grant-batch').status, 'active');
  const page = collection(f.store, 'grant', new URLSearchParams());
  assert.equal(page.total, 1); assert.equal(page.items[0].entries[0].remaining, 1); assert.equal(page.items[0].current, true);
  assert.ok(handshake(f.store).capabilities.includes('operatorGrants.v1'));
  sound(f);
});

test('an exact approval entry is consumed once; wrong task, revision, workflow, operation, time and grantee are refused and consume nothing', async t => {
  const f = await migrated(t);
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Done'] } }));
  issue(f, 'grant-1', [approveEntry(f)]);
  // Operational delegation no longer approves a brief.
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction }), /needs a stored operator grant covering this exact task revision and workflow/);
  // Wrong grantee: the operator acts directly and cites no grant.
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { actor: 'operator', authority: ref(f, 'grant-1', 'approve-task-1') }), /issued to the orchestrator; the operator acts directly/);
  // Wrong task, stale grant version, missing entry, unknown grant (a job id or another project's grant).
  refused(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-1', 'approve-task-1') }), /pins task task-1 revision .*, not task-2/);
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { authority: { ...ref(f, 'grant-1', 'approve-task-1'), expectedVersion: 7 } }), /changed \(version 1, expected 7\)/);
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { authority: ref(f, 'grant-1', 'approve-task-2') }), /has no entry approve-task-2/);
  const job = ok(as(f, 'job.enqueue', { operation: 'audit', note: 'Fictional audit' }, { onBehalfOf: instruction }));
  assert.equal(job.grant.actor, 'orchestrator', 'a job grant keeps its real actor');
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { authority: { grantId: job.id, entryId: 'grant', expectedVersion: 1 } }), /no operator grant .*job, schedule and integration grants do not/);
  // Wrong project: the envelope names another project (grant records are bound to this one).
  assert.throws(() => executeCommand(f.store, { protocolVersion: 1, projectId: 'project-fictional-other', commandId: uid(), operation: 'task.approve', payload: { taskId: 'task-1', revision: rev(f) }, actor: 'orchestrator', authority: ref(f, 'grant-1', 'approve-task-1') }), /wrong project identity/);
  // Authority references only go with operations they can authorize.
  assert.throws(() => as(f, 'flow.start', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction, authority: ref(f, 'grant-1', 'approve-task-1') }), /flow.start cannot use grant authority/);
  assert.deepEqual(usage(f, 'grant-1'), {}); assert.equal(grantUses(f, 'grant-1').length, 0);
  // The exact use: consumed in the command that approves.
  const payload = { taskId: 'task-1', revision: rev(f) }, authority = ref(f, 'grant-1', 'approve-task-1');
  const first = as(f, 'task.approve', payload, { onBehalfOf: instruction, authority, commandId: 'cmd-grant-approve' });
  const approved = ok(first);
  assert.equal(approved.approvalAuthority.source, 'grant'); assert.equal(approved.approvalAuthority.grantId, 'grant-1');
  assert.deepEqual(first.authority, authority, 'the receipt records the authority reference');
  assert.deepEqual(usage(f, 'grant-1'), { 'approve-task-1': 1 });
  const [use] = grantUses(f, 'grant-1');
  assert.equal(use.subjectDigest, authoritySubjectDigest({ operation: 'task.approve', disposition: 'approve', taskId: 'task-1', taskRevision: payload.revision, workflowDigest: approved.approvalAuthority.workflowDigest }));
  assert.ok(f.store.events().some(e => e.type === 'command.completed' && e.payload.commandId === 'cmd-grant-approve' && e.payload.authority?.grantId === 'grant-1'));
  // Same command replayed: its first receipt, no second use. Altered payload or reference under that id: refused.
  assert.deepEqual(as(f, 'task.approve', payload, { onBehalfOf: instruction, authority, commandId: 'cmd-grant-approve' }), first);
  assert.deepEqual(usage(f, 'grant-1'), { 'approve-task-1': 1 }); assert.equal(grantUses(f, 'grant-1').length, 1);
  assert.throws(() => as(f, 'task.approve', payload, { onBehalfOf: instruction, authority: { ...authority, entryId: 'approve-task-2' }, commandId: 'cmd-grant-approve' }), /command id reused with different content/);
  assert.throws(() => as(f, 'task.approve', { ...payload, queue: true }, { onBehalfOf: instruction, authority, commandId: 'cmd-grant-approve' }), /command id reused with different content/);
  assert.throws(() => as(f, 'task.approve', payload, { onBehalfOf: instruction, commandId: 'cmd-grant-approve' }), /command id reused with different content/);
  // A new command id cannot reuse the one-use entry.
  refused(as(f, 'task.approve', payload, { authority: ref(f, 'grant-1', 'approve-task-1') }), /is spent \(1 of 1 use\)/);
  // Wrong revision: the brief changed after the grant was issued.
  issue(f, 'grant-2', [approveEntry(f, 'task-2')]);
  edit(f, { title: 'Second fictional task, revised', acceptance: ['Done'] }, 'task-2');
  refused(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-2', 'approve-task-2') }), /pins task task-2 revision .*, not task-2 revision/);
  // Wrong workflow: the project's workflow changed after the grant was issued.
  issue(f, 'grant-3', [approveEntry(f, 'task-2')]);
  shipWorkflow(f);
  refused(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-3', 'approve-task-2') }), /pins workflow .*but task task-2 selects/);
  // Wrong time: not yet valid, and expired.
  const future = issue(f, 'grant-4', [approveEntry(f, 'task-2')], { notBefore: later(3600000), expiresAt: later(7200000) });
  refused(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-4', 'approve-task-2') }), /not valid before/);
  const short = issue(f, 'grant-5', [approveEntry(f, 'task-2')], { expiresAt: later(60000) });
  await afterExpiry(t, short, () => refused(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-5', 'approve-task-2') }), /expired at/));
  for (const grantId of ['grant-2', 'grant-3', 'grant-4', 'grant-5']) { assert.deepEqual(usage(f, grantId), {}, `${grantId} consumed nothing`); assert.equal(grantUses(f, grantId).length, 0); }
  assert.equal(future.status, 'active');
  // Direct operator approval still works and records direct provenance.
  const direct = ok(f.command('task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }));
  assert.equal(direct.approvalAuthority.source, 'direct-operator');
  assert.equal(f.store.need('authorityUse', direct.approvalAuthority.authorityUseId).source, 'direct-operator');
  sound(f);
});

test('a batch approval grant cannot answer a decision, and task.restart cannot approve itself; rollback consumes nothing', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a');
  issue(f, 'grant-batch', [approveEntry(f)]);
  // A batch approval entry is not an answer to anything.
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional', relay }, { onBehalfOf: instruction, authority: ref(f, 'grant-batch', 'approve-task-1') }), /permits task.approve \(approve\), not decision.dispose \(answer\)/);
  const card = ok(f.command('decision.present', { decisionId: a.id, expectedDecisionVersion: 1 }));
  refused(as(f, 'answer', { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: 'json', relay }, { onBehalfOf: instruction, authority: ref(f, 'grant-batch', 'approve-task-1') }), /permits task.approve \(approve\), not decision.dispose \(answer\)/);
  assert.equal(decision(f, a.id).status, 'unresolved'); assert.equal(f.store.need('inbox', card.id).status, 'open');
  assert.deepEqual(usage(f, 'grant-batch'), {});
  // Restart: operational delegation settles and restarts, but cannot approve a new revision.
  ok(f.command('task.approve', { taskId: 'task-1', revision: rev(f) }));
  ok(f.command('flow.start', { taskId: 'task-1', flowId: 'flow-1' }));
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional: pause before the edit' }));
  edit(f, { title: 'Fictional feature, revised' });
  const flowsBefore = f.store.all('flow').length;
  refused(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }, { onBehalfOf: instruction }), /task.approve by the orchestrator needs a stored operator grant/);
  assert.equal(f.store.all('flow').length, flowsBefore); assert.equal(f.store.need('flow', 'flow-1').state, 'stopped', 'the whole restart rolled back');
  // The old batch entry pins the earlier revision: not this one.
  refused(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }, { onBehalfOf: instruction, authority: ref(f, 'grant-batch', 'approve-task-1') }), /pins task task-1 revision/);
  // Rollback: the restart's nested approval consumes the entry, then admission is refused by a
  // build hold, so the whole command rolls back and the entry stays unused.
  issue(f, 'grant-restart', [approveEntry(f)]);
  const build = open(f, 'decision-build', { requiredAt: ['build'] });
  refused(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }, { onBehalfOf: instruction, authority: ref(f, 'grant-restart', 'approve-task-1') }), /admission refused: decision-held/);
  assert.deepEqual(usage(f, 'grant-restart'), {}); assert.equal(grantUses(f, 'grant-restart').length, 0);
  assert.notEqual(f.store.need('task', 'task-1').approvedRevision, rev(f));
  ok(f.command('decision.dispose', { decisionId: build.id, expectedDecisionVersion: build.version, kind: 'answer', optionId: 'json', rationale: 'Fictional: settled' }));
  // With an exact entry for the new revision, the restart approves once and starts.
  const restarted = ok(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }, { onBehalfOf: instruction, authority: ref(f, 'grant-restart', 'approve-task-1') }));
  assert.ok(restarted.flowId); assert.deepEqual(usage(f, 'grant-restart'), { 'approve-task-1': 1 }); assert.equal(grantUses(f, 'grant-restart').length, 1);
  assert.equal(f.store.need('task', 'task-1').approvalAuthority.grantId, 'grant-restart');
  // A reference the command does not use is refused rather than ignored.
  ok(f.command('stop', { flowId: restarted.flowId, note: 'Fictional stop' }));
  issue(f, 'grant-spare', [approveEntry(f)]);
  refused(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart again' }, { onBehalfOf: instruction, authority: ref(f, 'grant-spare', 'approve-task-1') }), /did not use the cited grant entry grant-spare\/approve-task-1/);
  assert.deepEqual(usage(f, 'grant-spare'), {});
  sound(f);
});

test('two processes racing one one-use entry: exactly one approval succeeds and one use is recorded', async t => {
  const f = await migrated(t);
  issue(f, 'grant-race', [approveEntry(f)]);
  const authority = ref(f, 'grant-race', 'approve-task-1'), revision = rev(f), go = join(f.base, 'go');
  const script = `import { Store } from ${JSON.stringify(join(repo, 'starter/factory/core/store.mjs'))};
import { executeCommand } from ${JSON.stringify(join(repo, 'starter/factory/core/project.mjs'))};
import { existsSync, writeFileSync } from 'node:fs';
const [stateDir, go, commandId] = process.argv.slice(1);
const store = new Store(stateDir);
writeFileSync(go + '.' + commandId, 'ready');
while (!existsSync(go)) await new Promise(r => setTimeout(r, 5));
const receipt = executeCommand(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId, operation: 'task.approve', payload: { taskId: 'task-1', revision: ${JSON.stringify(revision)} }, actor: 'orchestrator', authority: ${JSON.stringify(authority)} });
store.close(); process.stdout.write(JSON.stringify({ status: receipt.status, error: receipt.error ?? null }));`;
  const run = commandId => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.stateDir, go, commandId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer ${commandId} exited ${code}: ${err}`)));
  });
  const racers = [run('race-a'), run('race-b')];
  await until(() => existsSync(`${go}.race-a`) && existsSync(`${go}.race-b`));
  writeFileSync(go, 'go');
  const results = await Promise.all(racers);
  assert.equal(results.filter(r => r.status === 'completed').length, 1, JSON.stringify(results));
  const loser = results.find(r => r.status === 'rejected');
  assert.match(loser.error, /changed \(version 2, expected 1\)|is spent/);
  assert.deepEqual(usage(f, 'grant-race'), { 'approve-task-1': 1 }); assert.equal(grantUses(f, 'grant-race').length, 1);
  assert.equal(f.store.all('authorityUse').filter(u => u.operation === 'task.approve').length, 1);
  sound(f);
});

test('decision grants pin the exact version, options and answer; relayed answers settle nothing without one', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a'), b = open(f, 'decision-b');
  // Issue-time pins: options, version, supersession and multi-revision decisions.
  refused(f.command('grant.issue', { expiresAt: later(), entries: [answerEntry(f, a.id, ['json'], { optionSetDigest: digest('other options') })] }), /scope or option-set digest does not match/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [answerEntry(f, a.id, ['json'], { answers: [{ optionId: 'toml', payloadDigest: digest('toml') }] })] }), /answer toml is not an exact option/);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [answerEntry(f, a.id, ['json'], { obligationVersion: 2 })] }), /at version 1, not 2/);
  const { answers, ...bare } = answerEntry(f, a.id);
  refused(f.command('grant.issue', { expiresAt: later(), entries: [{ ...bare, disposition: 'supersede', payloadDigest: digest('fictional') }] }), /supersession is final/);
  issue(f, 'grant-a', [answerEntry(f, a.id, ['json'])]);
  // Wrong answer, wrong decision, no grant at all.
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'yaml', rationale: 'Fictional', relay }, { authority: ref(f, 'grant-a', `answer-${a.id}`) }), /does not permit answer yaml/);
  refused(as(f, 'decision.dispose', { decisionId: b.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional', relay }, { authority: ref(f, 'grant-a', `answer-${a.id}`) }), /pins decision decision-a version 1, not decision-b/);
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional' }, { onBehalfOf: instruction }), /needs the operator directly, or a stored operator grant entry/);
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'cancel', reason: 'Fictional', rationale: 'Fictional' }, { authority: ref(f, 'grant-a', `answer-${a.id}`) }), /permits decision.dispose \(answer\), not decision.dispose \(cancel\)/);
  assert.deepEqual(usage(f, 'grant-a'), {}); assert.equal(decision(f, a.id).status, 'unresolved');
  // Relayed answer: the operator's words, verbatim, kept as evidence. No payload field makes it the operator's.
  refused(as(f, 'decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote: 'Go with YAML.', channel: 'fictional chat', actor: 'operator' }), /does not accept actor/);
  refused(as(f, 'decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote: 'Go with YAML.', channel: 'fictional chat', answeredBy: 'operator' }, { onBehalfOf: instruction }), /does not accept answeredBy/);
  refused(f.command('decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote: 'Go with YAML.', channel: 'fictional chat' }), /the operator answers directly/);
  assert.throws(() => as(f, 'decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote: 'Go with YAML.', channel: 'fictional chat' }, { authority: ref(f, 'grant-a', `answer-${a.id}`) }), /decision.relay cannot use grant authority/);
  const quote = 'Honestly, YAML. The fictional team reads it more easily.';
  const relayed = ok(as(f, 'decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote, channel: 'fictional chat thread' }, { onBehalfOf: instruction }));
  assert.equal(relayed.relayedAnswer.relayedBy, 'orchestrator'); assert.equal(relayed.relayedAnswer.quote, quote); assert.equal(relayed.relayedAnswer.status, 'pending');
  assert.equal(decision(f, a.id).status, 'unresolved', 'a relayed answer never settles a decision on its own');
  assert.deepEqual(decisionHolds(f.store, 'task-1', rev(f), 'merge').map(h => h.decisionId), [a.id, b.id]);
  assert.equal(f.store.need('inbox', `relayed-answer:${relayed.relayedAnswer.id}`).status, 'open', 'presented for operator confirmation');
  // Through the card: without a grant, a relay keeps the card open; without a relay, it is refused.
  const card = ok(f.command('decision.present', { decisionId: a.id, expectedDecisionVersion: 1 }));
  const reply = (choice, extra = {}, options = {}) => as(f, 'answer', { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: choice, ...extra }, { onBehalfOf: instruction, ...options });
  refused(reply('yaml'), /needs the operator directly, or a stored operator grant entry/);
  refused(reply('yaml', { relay: { quote, channel: 'fictional chat', actor: 'operator' } }), /relay is \{quote, channel\}/);
  const viaCard = ok(reply('yaml', { relay: { quote: 'YAML, please.', channel: 'fictional call' } }));
  assert.equal(viaCard.decisionRemains, a.id); assert.equal(f.store.need('inbox', card.id).status, 'open');
  assert.equal(f.store.need('relayedAnswer', viaCard.relayedAnswerId).inboxId, card.id);
  // The operator confirms one relay directly; the other is superseded.
  refused(f.command('decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', relayedAnswerId: relayed.relayedAnswer.id, rationale: 'Fictional' }), /relayed option yaml, not json/);
  const confirmed = ok(f.command('decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'yaml', relayedAnswerId: relayed.relayedAnswer.id, rationale: 'Confirming what I said in chat.' }));
  assert.equal(confirmed.authorityUse.source, 'direct-operator'); assert.equal(confirmed.disposition.relayedAnswerId, relayed.relayedAnswer.id);
  assert.equal(f.store.need('relayedAnswer', relayed.relayedAnswer.id).status, 'confirmed');
  assert.equal(f.store.need('relayedAnswer', viaCard.relayedAnswerId).status, 'superseded');
  assert.equal(f.store.need('inbox', `relayed-answer:${relayed.relayedAnswer.id}`).status, 'superseded');
  // A grant-backed answer through the card, carrying the relay it acts on: applied.
  issue(f, 'grant-b', [answerEntry(f, b.id, ['json', 'yaml'])]);
  const cardB = ok(f.command('decision.present', { decisionId: b.id, expectedDecisionVersion: 1 }));
  const answeredB = ok(as(f, 'answer', { inboxId: cardB.id, version: cardB.version, subjectDigest: cardB.subjectDigest, answer: 'json', relay: { quote: 'JSON for b.', channel: 'fictional chat' } }, { onBehalfOf: instruction, authority: ref(f, 'grant-b', `answer-${b.id}`) }));
  const dispositionB = f.store.need('decisionDisposition', answeredB.dispositionId), useB = f.store.need('authorityUse', dispositionB.authorityUseId);
  assert.equal(decision(f, b.id).status, 'resolved'); assert.equal(useB.source, 'grant'); assert.equal(useB.grantId, 'grant-b');
  assert.equal(f.store.need('relayedAnswer', answeredB.relayedAnswerId).status, 'applied');
  assert.deepEqual(usage(f, 'grant-b'), { [`answer-${b.id}`]: 1 });
  // subjectDigest: every use, direct or granted, is the digest of its disposition's exact subject; the audit checks it.
  for (const d of f.store.all('decisionDisposition')) assert.equal(f.store.need('authorityUse', d.authorityUseId).subjectDigest, authoritySubjectDigest(dispositionSubject(d)));
  sound(f);
  f.store.put('authorityUse', { ...useB, subjectDigest: digest('another subject') });
  assert.match(auditAuthorityRecords(f.store).map(p => p.reason).join('\n'), /subject digest is not the digest of disposition/);
  f.store.put('authorityUse', useB); sound(f);
  // A cancellation grant pins the exact cancellation reason.
  const c = open(f, 'decision-c');
  const { answers: _, ...cancelBase } = answerEntry(f, c.id);
  issue(f, 'grant-c', [{ ...cancelBase, entryId: 'cancel-c', disposition: 'cancel', payloadDigest: cancellationPayloadDigest(c, 'The fictional export is dropped.') }]);
  refused(as(f, 'decision.dispose', { decisionId: c.id, expectedDecisionVersion: 1, kind: 'cancel', reason: 'Something else.', rationale: 'Fictional' }, { authority: ref(f, 'grant-c', 'cancel-c') }), /pins a different cancellation/);
  ok(as(f, 'decision.dispose', { decisionId: c.id, expectedDecisionVersion: 1, kind: 'cancel', reason: 'The fictional export is dropped.', rationale: 'Fictional' }, { authority: ref(f, 'grant-c', 'cancel-c') }));
  assert.equal(decision(f, c.id).status, 'canceled');
  sound(f);
});

test('revocation and expiry invalidate derived clearances going forward; ratification restores one only under slice A/B rules', async t => {
  const f = await migrated(t);
  shipWorkflow(f);
  const a = open(f, 'decision-a');
  issue(f, 'grant-a', [answerEntry(f, a.id)]);
  const answered = ok(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional: within the grant', relay }, { authority: ref(f, 'grant-a', `answer-${a.id}`), commandId: 'cmd-granted-answer' }));
  ok(f.command('task.approve', { taskId: 'task-1', revision: rev(f) }));
  ok(f.command('flow.start', { taskId: 'task-1', flowId: 'flow-1' }));
  await f.engine.step('flow-1');
  const { attempt, dir } = labelFakeMerge(f, 0);
  assert.equal(attempt.status, 'prepared');
  // Revocation after preparation: the clearance is gone, the prepared intent fails the fence.
  const revoked = ok(f.command('grant.revoke', { grantId: 'grant-a', expectedVersion: 2, reason: 'Fictional: reconsider' }));
  assert.deepEqual(revoked.dispositions, [answered.disposition.id]);
  assert.equal(decision(f, a.id).status, 'unresolved'); assert.equal(f.store.need('decisionDisposition', answered.disposition.id).status, 'inactive');
  assert.equal(f.store.need('authorityUse', answered.authorityUse.id).status, 'inactive');
  assert.deepEqual(grantOf(f, 'grant-a').usage, { [`answer-${a.id}`]: 1 }, 'revocation consumes nothing and restores nothing');
  await f.engine.tick();
  const fenced = f.store.need('attempt', attempt.id);
  assert.equal(fenced.status, 'not-dispatched'); assert.equal(existsSync(join(dir, 'owner.json')), false, 'no launch');
  assert.equal(f.store.need('flow', 'flow-1').decisionHold.boundary, 'merge');
  // Replay of the granted answer returns its canonical receipt, without claiming current validity or reapplying.
  const replay = as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional: within the grant', relay }, { authority: { grantId: 'grant-a', entryId: `answer-${a.id}`, expectedVersion: 1 }, commandId: 'cmd-granted-answer' });
  assert.equal(replay.status, 'completed'); assert.equal(decision(f, a.id).status, 'unresolved');
  // Direct ratification restores the unchanged answer; the step continues.
  ok(f.command('decision.ratify', { decisionId: a.id, expectedDecisionVersion: decision(f, a.id).version, inactiveDispositionId: answered.disposition.id, rationale: 'Fictional: the answer stands' }));
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  sound(f);
});

test('grant expiry lapses a clearance at the boundary immediately, the engine records it, and ratification is refused across a changed revision', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a'), b = open(f, 'decision-b');
  const grant = issue(f, 'grant-short', [answerEntry(f, a.id), answerEntry(f, b.id)], { expiresAt: later(120000) });
  const answeredA = ok(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional', relay }, { authority: ref(f, 'grant-short', `answer-${a.id}`) }));
  const answeredB = ok(as(f, 'decision.dispose', { decisionId: b.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional', relay }, { authority: ref(f, 'grant-short', `answer-${b.id}`) }));
  assert.deepEqual(decisionHolds(f.store, 'task-1', rev(f), 'merge'), []);
  // Decision b is then carried to a revised brief: settled there only for the old revision.
  const versionA = decision(f, a.id).version;
  edit(f, { title: 'Fictional feature, revised' });
  await afterExpiry(t, grant, async () => {
    // At the boundary the lapse is read from the grant at once, before anything records it.
    const held = decisionHolds(f.store, 'task-1', rev(f), 'merge');
    assert.ok(held.some(h => h.decisionId === a.id && h.state !== 'covered'));
    // The engine records the lapse: inactive history, unresolved decisions.
    await f.engine.tick();
    assert.ok(f.store.events().some(e => e.type === 'grant.expired' && e.payload.grantId === 'grant-short'));
  });
  assert.equal(f.store.need('decisionDisposition', answeredA.disposition.id).status, 'inactive');
  assert.match(f.store.need('decisionDisposition', answeredA.disposition.id).inactiveReason, /expired/);
  assert.equal(decision(f, a.id).status, 'unresolved'); assert.equal(decision(f, a.id).version, versionA + 2);
  // a also applies to the revised brief now, which its answer did not cover: ratification is refused.
  refused(f.command('decision.ratify', { decisionId: a.id, expectedDecisionVersion: decision(f, a.id).version, inactiveDispositionId: answeredA.disposition.id, rationale: 'Fictional' }), /answer anew/);
  // Revert the brief: the revision set is still wider than the answer covered, so it stays refused; answer anew.
  ok(f.command('decision.dispose', { decisionId: a.id, expectedDecisionVersion: decision(f, a.id).version, kind: 'answer', optionId: 'json', rationale: 'Fictional: answered directly for both revisions' }));
  assert.equal(decision(f, a.id).status, 'resolved');
  assert.equal(f.store.need('authorityUse', answeredB.authorityUse.id).status, 'inactive');
  sound(f);
});

test('ratification after a grant expired restores the unchanged answer', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a');
  const grant = issue(f, 'grant-short', [answerEntry(f, a.id)], { expiresAt: later(120000) });
  const answered = ok(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional', relay }, { authority: ref(f, 'grant-short', `answer-${a.id}`) }));
  const shown = decision(f, a.id).version;
  await afterExpiry(t, grant, () => {
    // The console shows the lapse and offers ratification of the version it read; the command records the lapse first.
    // Before anything records the lapse, the boundary already holds: the clearance rests on an expired grant.
    assert.deepEqual(decisionHolds(f.store, 'task-1', rev(f), 'merge').map(h => [h.decisionId, h.state]), [[a.id, 'grant-lapsed']]);
    const view = collection(f.store, 'decision', new URLSearchParams()).items.find(d => d.id === a.id);
    assert.match(view.clearanceLapse, /expired/); assert.deepEqual(view.ratifiable, [answered.disposition.id]);
    ok(f.command('decision.ratify', { decisionId: a.id, expectedDecisionVersion: shown, inactiveDispositionId: answered.disposition.id, rationale: 'Fictional: the answer stands' }));
  });
  const o = decision(f, a.id), d = f.store.need('decisionDisposition', o.activeDispositionId);
  assert.equal(o.status, 'resolved'); assert.equal(d.ratifiesDispositionId, answered.disposition.id);
  assert.equal(f.store.need('authorityUse', d.authorityUseId).source, 'direct-operator');
  assert.deepEqual(decisionHolds(f.store, 'task-1', rev(f), 'merge'), []);
  sound(f);
});

test('approvals through a grant stop authorizing work when it is revoked or expires; effects already performed stay', async t => {
  const f = await migrated(t);
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Done'] } }));
  shipWorkflow(f);
  // Revocation after a dispatched merge: the effect completes as fact; the approval is withdrawn.
  issue(f, 'grant-1', [approveEntry(f)]);
  const approve = as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction, authority: ref(f, 'grant-1', 'approve-task-1'), commandId: 'cmd-approve-1' });
  ok(approve);
  ok(as(f, 'flow.start', { taskId: 'task-1', revision: rev(f), flowId: 'flow-1' }, { onBehalfOf: instruction }));
  await f.engine.step('flow-1');
  const { attempt } = labelFakeMerge(f, 900);
  await f.engine.step('flow-1');
  assert.equal(f.store.need('attempt', attempt.id).status, 'dispatching');
  const revoked = ok(f.command('grant.revoke', { grantId: 'grant-1', expectedVersion: 2, reason: 'Fictional: change of plan' }));
  assert.deepEqual(revoked.approvals, ['task-1']);
  const task = f.store.need('task', 'task-1');
  assert.equal(task.approvedRevision, null); assert.equal(task.approvalAuthority, undefined);
  assert.equal(f.store.need('flow', 'flow-1').stopRequested, true);
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick(), timeout: 30000 });
  assert.notEqual(f.store.need('attempt', attempt.id).status, 'not-dispatched', 'a dispatched effect is not claimed prevented');
  assert.deepEqual(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction, authority: { grantId: 'grant-1', entryId: 'approve-task-1', expectedVersion: 1 }, commandId: 'cmd-approve-1' }), approve, 'replay returns the canonical receipt after revocation');
  assert.equal(f.store.need('task', 'task-1').approvedRevision, null, 'replay reapplies nothing');
  ok(f.command('flow.abandon', { flowId: 'flow-1', note: 'Fictional: the grant was revoked' }));
  // Expiry after preparation: the prepared intent fails the dispatch fence; nothing launches.
  ok(f.command('task.put', { task: { id: 'task-3', title: 'Third fictional task', acceptance: ['Done'] } }));
  const short = issue(f, 'grant-2', [approveEntry(f, 'task-2'), approveEntry(f, 'task-3')], { expiresAt: later(120000) });
  ok(as(f, 'task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }, { authority: ref(f, 'grant-2', 'approve-task-2') }));
  ok(as(f, 'task.approve', { taskId: 'task-3', revision: rev(f, 'task-3') }, { authority: ref(f, 'grant-2', 'approve-task-3') }));
  ok(f.command('flow.start', { taskId: 'task-2', flowId: 'flow-2' }));
  await f.engine.step('flow-2');
  const prepared = f.store.all('attempt').filter(x => x.flowId === 'flow-2').at(-1), preparedDir = join(f.stateDir, 'attempts', prepared.id);
  assert.equal(prepared.status, 'prepared');
  await afterExpiry(t, short, async () => {
    assert.deepEqual(taskView(f.store, f.store.need('task', 'task-2')).approvalAuthorityReasons.length, 1);
    // Admission reads the grant at once, before the engine records the lapse.
    refused(f.command('flow.start', { taskId: 'task-3', revision: rev(f, 'task-3'), flowId: 'flow-3' }), /approval is no longer valid: grant grant-2 expired/);
    await f.engine.tick(); await f.engine.tick();
  });
  const after = f.store.need('attempt', prepared.id);
  assert.equal(after.status, 'not-dispatched'); assert.equal(after.dispatchedAt, undefined);
  assert.equal(existsSync(join(preparedDir, 'owner.json')), false, 'the supervisor never launched');
  assert.equal(f.store.need('flow', 'flow-2').state, 'stopped');
  assert.equal(f.store.need('task', 'task-2').approvedRevision, null, 'the engine recorded the lapse');
  // Direct operator approval restores it.
  const direct = ok(f.command('task.approve', { taskId: 'task-2', revision: rev(f, 'task-2') }));
  assert.equal(direct.approvalAuthority.source, 'direct-operator');
  sound(f);
});

test('policy widening through config.update, replaceLive or settings.update fails for the orchestrator; ordinary delegation still works', async t => {
  const f = await migrated(t);
  const current = () => f.store.meta('config', {});
  // Ordinary operational delegation still works on a migrated project.
  ok(as(f, 'task.label', { taskId: 'task-1', labels: ['fictional'] }, { onBehalfOf: instruction }));
  ok(as(f, 'config.update', { config: { ...current(), policy: { ...(current().policy ?? {}), maxFlows: 2 } }, note: 'Fictional: capacity' }, { onBehalfOf: instruction }));
  ok(as(f, 'settings.update', { changes: { 'policy.autoQueue': true }, note: 'Fictional: queue' }, { onBehalfOf: instruction }));
  // Authority-bearing policy: refused for the orchestrator, by full replacement or replaceLive.
  refused(as(f, 'config.update', { config: { ...current(), policy: { ...current().policy, mergeDecisionRole: 'orchestrator' } }, note: 'Fictional' }, { onBehalfOf: instruction }), /cannot change authority-bearing policy \(policy.mergeDecisionRole\)/);
  refused(as(f, 'config.update', { config: { ...current(), policy: { ...current().policy, delegateIntegrationDecisions: true } }, replaceLive: true, note: 'Fictional' }, { onBehalfOf: instruction }), /policy.delegateIntegrationDecisions/);
  refused(as(f, 'settings.update', { changes: { 'policy.delegatedOperations': ['answer'] }, note: 'Fictional' }, { onBehalfOf: instruction }), /can only be changed by the operator/);
  // The operator narrows delegation; a later full replacement that omits the key (back to the default) widens it.
  ok(f.command('settings.update', { changes: { 'policy.delegatedOperations': ['answer', 'config.update', 'task.label'] }, note: 'Fictional: narrow' }));
  const { delegatedOperations, ...withoutDelegation } = current().policy;
  refused(as(f, 'config.update', { config: { ...current(), policy: withoutDelegation }, replaceLive: true, note: 'Fictional' }, { onBehalfOf: instruction }), /policy.delegatedOperations/);
  assert.deepEqual(current().policy.delegatedOperations, ['answer', 'config.update', 'task.label']);
  // The operator, directly, may change it.
  ok(f.command('config.update', { config: { ...current(), policy: { ...current().policy, mergeDecisionRole: 'operator', delegatedOperations: ['answer', 'config.update', 'task.label', 'task.approve'] } }, note: 'Fictional: operator change' }));
  // Listing task.approve is operational delegation only: approving a brief still needs a grant.
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { onBehalfOf: instruction }), /needs a stored operator grant/);
  // The normalized comparison also covers recurrence approval templates, integration authorization and question roles.
  const base = authorityPolicy({}, { workflow: f.store.meta('workflow') });
  assert.notEqual(digest(base.recurringTasks), digest(authorityPolicy({ recurringTasks: { weekly: { task: { title: 'Fictional' } } } }).recurringTasks));
  const asked = { version: 1, start: 'q', nodes: { q: { kind: 'question', role: 'operator', answers: { go: 'done' } }, done: { kind: 'end', outcome: 'completed' } } };
  assert.notEqual(digest(authorityPolicy({}, { workflow: asked })['workflow question roles']), digest(authorityPolicy({}, { workflow: { ...asked, nodes: { ...asked.nodes, q: { ...asked.nodes.q, role: 'orchestrator' } } } })['workflow question roles']));
  sound(f);
});

test('consumption, revocation and replay survive a process restart', async t => {
  const f = await migrated(t);
  issue(f, 'grant-1', [approveEntry(f)]);
  const payload = { taskId: 'task-1', revision: rev(f) }, authority = ref(f, 'grant-1', 'approve-task-1');
  const first = ok(as(f, 'task.approve', payload, { authority, commandId: 'cmd-restart-approve' }));
  const second = new Store(f.stateDir); t.after(() => second.close());
  const again = executeCommand(second, { protocolVersion: 1, projectId: f.project.projectId, commandId: 'cmd-restart-approve', operation: 'task.approve', payload, actor: 'orchestrator', authority });
  assert.equal(again.status, 'completed'); assert.deepEqual(again.result, first);
  assert.deepEqual(second.need('operatorGrant', 'grant-1').usage, { 'approve-task-1': 1 });
  const revoke = executeCommand(second, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation: 'grant.revoke', payload: { grantId: 'grant-1', expectedVersion: 2, reason: 'Fictional' }, actor: 'operator' });
  assert.equal(revoke.status, 'completed', revoke.error);
  const third = new Store(f.stateDir); t.after(() => third.close());
  assert.equal(third.need('operatorGrant', 'grant-1').status, 'revoked'); assert.equal(third.need('task', 'task-1').approvedRevision, null);
  assert.deepEqual(auditAuthorityRecords(third), []);
});

test('the console journals and forwards the authority reference in its command digest; the CLI sends it', async t => {
  const f = await migrated(t);
  issue(f, 'grant-console', [approveEntry(f)]);
  const service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'grants.sock'), run: false });
  const app = await startConsole({ stateDir: join(f.base, 'console'), port: 0, timeoutMs: 30000 });
  t.after(async () => { await app.close(); await service.close(); });
  const binding = await app.registerProject({ socketPath: service.socketPath });
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0], csrf = (await page.text()).match(/name="factotum-csrf" content="([^"]+)"/)[1];
  const send = async body => { const response = await fetch(`${app.url}/api/commands`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-factotum-csrf': csrf }, body: JSON.stringify({ projectId: f.project.projectId, bindingId: binding.bindingId, ...body }) }); return { status: response.status, body: await response.json() }; };
  const authority = ref(f, 'grant-console', 'approve-task-1'), commandId = uid();
  const command = { commandId, actor: 'orchestrator', operation: 'task.approve', payload: { taskId: 'task-1', revision: rev(f) }, authority };
  const sent = await send(command);
  assert.equal(sent.status, 200); assert.equal(sent.body.status, 'completed', JSON.stringify(sent.body)); assert.deepEqual(sent.body.authority, authority);
  assert.deepEqual(sent.body.receipt.authority, authority);
  const altered = await send({ ...command, authority: { ...authority, entryId: 'approve-task-2' } });
  assert.equal(altered.status, 409);
  const dropped = await send({ ...command, authority: undefined });
  assert.equal(dropped.status, 409, 'dropping the reference under the same command id is refused too');
  assert.equal((await send(command)).body.status, 'completed');
  assert.deepEqual(usage(f, 'grant-console'), { 'approve-task-1': 1 });
  assert.equal((await send({ commandId: uid(), actor: 'operator', operation: 'grant.revoke', payload: { grantId: 'grant-console', expectedVersion: 2, reason: 'Fictional' } })).body.status, 'completed');
  // CLI: --authority is part of the envelope.
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Done'] } }));
  issue(f, 'grant-cli', [approveEntry(f, 'task-2')]);
  const cli = spawnSync(process.execPath, [join(repo, 'starter/factory/cli.mjs'), 'command', '--state', f.stateDir, '--operation', 'task.approve', '--payload', JSON.stringify({ taskId: 'task-2', revision: rev(f, 'task-2') }), '--actor', 'orchestrator', '--authority', JSON.stringify(ref(f, 'grant-cli', 'approve-task-2'))], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.equal(JSON.parse(cli.stdout).authority.grantId, 'grant-cli');
  assert.equal(f.store.need('task', 'task-2').approvalAuthority.grantId, 'grant-cli');
  sound(f);
});

test('the console shows exact grant entries before issue, confirms relays directly and revokes by version', async t => {
  const f = await migrated(t);
  ok(f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Done'] } }));
  const a = open(f, 'decision-a');
  ok(as(f, 'decision.relay', { decisionId: a.id, expectedDecisionVersion: 1, optionId: 'yaml', quote: 'YAML is fine by me.', channel: 'fictional chat' }));
  issue(f, 'grant-shown', [approveEntry(f, 'task-2')]);
  const snap = snapshot(f.store), view = snap.decisions.find(d => d.id === a.id);
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false)); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
    reportValidity() { return true; }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window', 'fetch'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {}, confirm: () => true } });
  try {
    const { durableDecisionCard, inboxView } = await import('../starter/factory/console/ui/inbox.mjs'), { state } = await import('../starter/factory/console/ui/state.mjs');
    const project = { projectId: f.project.projectId, bindingId: 'binding', name: 'Fictional', status: 'available', snapshot: snap };
    state.projects = [project];
    const descendants = node => [node, ...node.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
    const sent = [];
    globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'completed' }) }; };
    const submitAll = async node => { for (const form of descendants(node).filter(n => n.tag === 'form')) { for (const field of descendants(form).filter(n => n.name)) field.value = field.name === 'hours' ? '24' : 'Fictional rationale'; await form.handlers.submit({ preventDefault() {} }); } };
    const card = durableDecisionCard(project, view);
    assert.match(card.textContent, /YAML is fine by me\./); assert.match(card.textContent, /Awaiting your confirmation/);
    // The exact entry is shown on the card before the issue form.
    const parsed = text => { try { return JSON.parse(text); } catch { return null; } };
    const shown = descendants(card).filter(n => n.tag === 'pre').map(n => parsed(n.textContent)).filter(e => e?.operation === 'decision.dispose');
    assert.deepEqual(shown.map(e => e.answers.map(x => x.optionId)), [['json'], ['yaml']]);
    await submitAll(card);
    const confirm = sent.find(r => r.operation === 'decision.dispose' && r.payload.relayedAnswerId);
    assert.equal(confirm.actor, 'operator'); assert.equal(confirm.payload.optionId, 'yaml'); assert.equal(confirm.payload.expectedDecisionVersion, 1);
    const issued = sent.filter(r => r.operation === 'grant.issue');
    assert.deepEqual(issued.map(r => r.payload.entries), shown.map(e => [e]), 'what is issued is exactly what was shown');
    // Each issue command the console sends is accepted by the project as an exact grant.
    for (const row of issued) ok(f.command('grant.issue', row.payload));
    // Inbox: grants with revoke bound to the version read, and a batch approval of exactly the tasks awaiting approval.
    sent.length = 0;
    const inbox = inboxView(project, { params: {} });
    assert.match(inbox.textContent, /Operator grants/); assert.match(inbox.textContent, /grant-shown/);
    const batch = descendants(inbox).filter(n => n.tag === 'pre').map(n => parsed(n.textContent)).find(Array.isArray);
    assert.deepEqual(batch, [approveEntry(f, 'task-1', { maxUses: 1 }), approveEntry(f, 'task-2', { maxUses: 1 })].map(({ entryId, ...e }) => e));
    await submitAll(inbox);
    const revoke = sent.find(r => r.operation === 'grant.revoke');
    assert.deepEqual([revoke.payload.grantId, revoke.payload.expectedVersion], ['grant-shown', 1]);
    assert.deepEqual(sent.find(r => r.operation === 'grant.issue' && r.payload.entries[0].operation === 'task.approve').payload.entries, batch);
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  sound(f);
});

// Independent review fixes. A grant makes an answer entered on the operator's behalf
// effective; it never replaces the record of the operator's words.
test('a grant-backed answer must carry the relayed words: without them nothing settles or is consumed, on the command or the card', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a'), b = open(f, 'decision-b');
  issue(f, 'grant-a', [answerEntry(f, a.id)]);
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'The orchestrator chose this answer.' }, { authority: ref(f, 'grant-a', `answer-${a.id}`) }), /grant-backed answer .* must carry relay \{quote, channel\}/);
  refused(as(f, 'decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'Fictional' }, { onBehalfOf: instruction, authority: ref(f, 'grant-a', `answer-${a.id}`) }), /must carry relay \{quote, channel\}/);
  const card = ok(f.command('decision.present', { decisionId: a.id, expectedDecisionVersion: 1 }));
  refused(as(f, 'answer', { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: 'json' }, { onBehalfOf: instruction, authority: ref(f, 'grant-a', `answer-${a.id}`) }), /decision card through a grant .* must carry relay \{quote, channel\}/);
  assert.deepEqual(usage(f, 'grant-a'), {}); assert.equal(grantOf(f, 'grant-a').version, 1); assert.deepEqual(grantUses(f, 'grant-a'), []);
  assert.equal(decision(f, a.id).status, 'unresolved'); assert.equal(f.store.need('inbox', card.id).status, 'open');
  assert.equal(f.store.all('relayedAnswer').length, 0); assert.equal(f.store.all('decisionDisposition').length, 0);
  sound(f);
  // With the words, the same answer settles through the grant and the relay is applied.
  const answered = ok(as(f, 'answer', { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: 'json', relay }, { onBehalfOf: instruction, authority: ref(f, 'grant-a', `answer-${a.id}`) }));
  const applied = f.store.need('relayedAnswer', answered.relayedAnswerId);
  assert.deepEqual([applied.status, applied.quote, applied.channel, applied.relayedBy, applied.dispositionId], ['applied', relay.quote, relay.channel, 'orchestrator', answered.dispositionId]);
  sound(f);
  // The audit refuses a grant-backed answer that does not rest on its relayed answer.
  const d = f.store.need('decisionDisposition', answered.dispositionId), { relayedAnswerId: _, ...bare } = d;
  f.store.put('decisionDisposition', bare);
  assert.match(auditAuthorityRecords(f.store).map(p => p.reason).join('\n'), /grant-backed answer has no relayed answer/);
  f.store.put('decisionDisposition', d); sound(f);
  // The operator answering directly needs no relay.
  ok(f.command('decision.dispose', { decisionId: b.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'yaml', rationale: 'Fictional: answered directly' }));
  sound(f);
});

// Evidence corruption a legitimate history never produces: the decision names an active
// disposition that does not exist. Every protected write on the task is then refused.
const corrupt = (f, o) => f.store.put('decisionObligation', { ...o, activeDispositionId: 'missing-disposition', status: 'resolved', applicability: o.applicability.map(x => ({ ...x, state: 'covered', dispositionId: 'missing-disposition' })) });

test('approval, grant consumption and revocation roll back when the task-scoped audit fails', async t => {
  const f = await migrated(t);
  const a = decision(f, open(f, 'decision-a').id);
  issue(f, 'grant-approve', [approveEntry(f)]);
  issue(f, 'grant-unused', [approveEntry(f)]);
  corrupt(f, a);
  assert.ok(auditAuthorityRecords(f.store, { taskId: 'task-1' }).length);
  const before = f.store.need('task', 'task-1');
  // Grant-backed approval: refused, no approval, nothing consumed.
  refused(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { authority: ref(f, 'grant-approve', 'approve-task-1') }), /task.approve refused: it would leave decision-authority records of task task-1 that fail the audit/);
  // Direct operator approval: refused as well.
  refused(f.command('task.approve', { taskId: 'task-1', revision: rev(f) }), /task.approve refused: .*fail the audit/);
  // task.restart's nested approval: the whole restart is refused, nothing consumed.
  refused(as(f, 'task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }, { onBehalfOf: instruction, authority: ref(f, 'grant-approve', 'approve-task-1') }), /task.approve refused: .*fail the audit/);
  const after = f.store.need('task', 'task-1');
  assert.deepEqual([after.approvedRevision, after.approvalVersion, after.approvalAuthority], [before.approvedRevision, before.approvalVersion, before.approvalAuthority]);
  assert.deepEqual(usage(f, 'grant-approve'), {}); assert.equal(grantOf(f, 'grant-approve').version, 1); assert.deepEqual(grantUses(f, 'grant-approve'), []);
  assert.equal(f.store.all('authorityUse').filter(u => u.operation === 'task.approve').length, 0);
  assert.equal(f.store.all('flow').length, 0);
  // Revoking a grant nobody used still audits every task it names.
  refused(f.command('grant.revoke', { grantId: 'grant-unused', expectedVersion: 1, reason: 'Fictional: withdraw the unused authority' }), /grant.revoke refused: it would leave decision-authority records of task task-1 that fail the audit/);
  assert.deepEqual([grantOf(f, 'grant-unused').status, grantOf(f, 'grant-unused').version], ['active', 1]);
  // Repaired, the same commands succeed and the history audits clean.
  f.store.put('decisionObligation', a); sound(f);
  ok(f.command('grant.revoke', { grantId: 'grant-unused', expectedVersion: 1, reason: 'Fictional: withdraw the unused authority' }));
  ok(as(f, 'task.approve', { taskId: 'task-1', revision: rev(f) }, { authority: ref(f, 'grant-approve', 'approve-task-1') }));
  assert.deepEqual(usage(f, 'grant-approve'), { 'approve-task-1': 1 });
  sound(f);
});
