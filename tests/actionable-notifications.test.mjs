import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { flowNotice } from '../starter/factory/core/project.mjs';
import { deliverDue, queueDelivery, queueStateDeliveryInTransaction } from '../starter/factory/operations/notifications.mjs';

const queueInbox = store => { for (const item of store.all('inbox')) queueDelivery(store, { inboxId: item.id }); };
const head = 'a'.repeat(40);
function fixture(t, level = 'actionable') {
  const f = sandbox(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  const setLevel = value => f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level: value, configPath } });
  setLevel(level);
  const deliver = (nowMs = Date.now() + 1000) => deliverDue(f.store, { configPath, nowMs, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } });
  return { ...f, configPath, sent, setLevel, deliver };
}
function change(id, extra = {}) {
  return { id, kind: 'change', taskId: 'task-1', taskRevision: 'revision', step: 'done', state: 'completed', results: { merge: { merged: true, expectedHead: head }, cleanup: { released: true } }, ...extra };
}
function maintenance(id, operation, result, extra = {}) {
  return { ...change(id), kind: 'maintenance', jobId: `job-${id}`, workflow: { nodes: { run: { action: { operation } } } }, results: { run: result }, ...extra };
}
function finish(f, flow, outcome = 'completed', reason = '') {
  f.store.tx(() => {
    f.store.put('flow', flow);
    f.store.event('flow.finished', { flowId: flow.id, outcome });
    flowNotice(f.store, flow, outcome, reason);
  });
  return f.store.all('inbox').find(row => row.flowId === flow.id);
}
const question = { id: 'decision', kind: 'question', title: 'Choose a behavior', context: 'A product choice', question: 'Which behavior?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };

test('actionable filters clean delivery and target-sync transport while retaining canonical terminal evidence', async t => {
  const f = fixture(t);
  finish(f, change('delivery'));
  finish(f, change('document', { kind: 'document' }));
  finish(f, change('satisfied', { results: { 'satisfied-record': { proven: true }, cleanup: { released: true } } }));
  finish(f, maintenance('sync', 'target.sync', { route: 'pass', sync: { contained: true, head, fromHead: head } }));
  queueInbox(f.store); await f.deliver();
  assert.deepEqual(f.sent, []);
  assert.equal(f.store.all('inbox').length, 4, 'summaries remain canonical');
  assert.equal(f.store.all('flow').length, 4);
  assert.equal(f.store.events().filter(row => row.type === 'flow.finished').length, 4);
  assert.deepEqual(f.store.all('delivery').map(row => row.status), ['suppressed', 'suppressed', 'suppressed', 'suppressed']);
  for (const item of f.store.all('inbox')) assert.equal(f.command('inbox.ack', { inboxId: item.id }).status, 'completed');
  queueInbox(f.store); await f.deliver();
  assert.deepEqual(f.sent, [], 'operator acknowledgment of a routine summary cannot restore terminal noise');
});

test('engine completion still records the retrospective and task outcome under actionable', async t => {
  const f = fixture(t);
  assert.equal(f.start().status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  f.store.put('flow', { ...flow, step: 'done', results: change('x').results, kind: 'change', mergeAuthorization: { identity: { head } } });
  await f.engine.tick(); queueInbox(f.store); await f.deliver();
  assert.equal(f.store.need('flow', flow.id).state, 'completed');
  assert.equal(f.store.need('task', f.task.id).status, 'completed');
  assert.ok(f.store.get('retrospective', flow.id));
  assert.equal(f.sent.filter(body => body.kind === 'inbox').length, 0);
  assert.deepEqual(f.sent.map(body => body.event), ['task.approved']);
});

test('essential and all keep their existing ordinary terminal summaries', async t => {
  for (const level of ['essential', 'all']) {
    const f = fixture(t, level); finish(f, change('delivery'));
    queueInbox(f.store); await f.deliver();
    assert.equal(f.sent.filter(body => body.kind === 'inbox').length, 1, level);
    assert.equal(f.sent.filter(body => body.kind === 'state').length, level === 'all' ? 1 : 0, level);
  }
});

test('successful flows with obligations, findings, partial evidence or opaque results remain visible', async t => {
  const f = fixture(t), clean = change('clean').results;
  const flows = [
    change('cleanup', { results: { ...clean, cleanup: { released: false } } }),
    change('opaque', { results: { run: { route: 'pass' } } }),
    change('post-check', { taskSnapshot: { postMerge: ['Verify the public outcome'] } }),
    change('owed', { results: { ...clean, post: { route: 'recorded', obligations: [{ title: 'Review product choices', status: 'pending' }] } } }),
    change('stored-obligation'),
    change('partial', { results: { ...clean, scan: { route: 'partial' } } }),
    maintenance('audit', 'audit', { route: 'pass', findings: [{ title: 'Investigate' }] }),
    maintenance('green-with-cleanup', 'main.verify', { route: 'pass', mainHealth: { status: 'green' }, obligations: [{ title: 'Inspect preserved workspace' }] }),
    maintenance('unknown-sync', 'target.sync', { route: 'pass' }),
    maintenance('source-change', 'source.sync', { route: 'pass', sourceSync: { status: 'ok', complete: true, errors: 0, imported: 1, changed: 0, revoked: 0 } }),
    maintenance('source-partial', 'source.sync', { route: 'pass', sourceSync: { status: 'partial', complete: false } }),
    maintenance('custom', 'custom.run', { route: 'pass' }, { integration: { id: 'custom' } }),
    // Actual provider report shapes: material lives in the nested result and retained reports.
    change('unverified', { results: { ...clean, build: { route: 'implemented', result: { status: 'implemented', unverified: ['Acceptance needs the external service'], questions: [] } } } }),
    change('nested-findings', { results: { ...clean, review: { route: 'pass', result: { findings: [{ severity: 'low', message: 'Tidy later' }] } } } }),
    change('worker-report', { workerReports: [{ step: 'build', departures: [{ from: 'plan', why: 'API differed' }], unverified: [], questions: [] }] }),
    change('review-history', { reviewHistory: [{ result: { findings: [{ severity: 'high', message: 'Broken acceptance' }] } }, { result: { findings: [] } }] }),
    change('ci-rerun', { results: { ...clean, gate: { route: 'pass', rerun: { runs: [{ id: 1, status: 'completed', conclusion: 'success' }] } } } }),
  ];
  f.store.put('obligation', { id: 'owed', flowId: 'stored-obligation', status: 'pending', title: 'Review before release' });
  for (const flow of flows) finish(f, flow);
  // A standalone report is never classified by its associated flow's success.
  f.store.put('inbox', { id: 'product-report', kind: 'notice', flowId: 'cleanup', outcome: 'completed', status: 'open', version: 1, title: 'Product choices need review' });
  queueInbox(f.store); await f.deliver();
  assert.equal(f.sent.length, flows.length + 1);
  assert.ok(f.sent.every(body => body.kind === 'inbox'));
  // Only a latest "fixed" disposition with evidence resolves a historical review finding.
  const raised = { result: { findings: [{ severity: 'high', message: 'Broken acceptance' }] } };
  const disposed = (disposition, evidence = 'Covered by a regression test') => ({ result: { findings: [], priorFindingsDisposition: [{ finding: 'Broken acceptance', disposition, evidence }] } });
  const status = (id, reviewHistory) => queueDelivery(f.store, { inboxId: finish(f, change(id, { reviewHistory })).id }).status;
  assert.equal(status('history-fixed', [raised, disposed('fixed')]), 'suppressed');
  assert.notEqual(status('history-remaining', [raised, disposed('remaining', 'External acceptance still unchecked')]), 'suppressed');
  assert.notEqual(status('history-outside-scope', [raised, disposed('outside-scope', 'Deferred to another task')]), 'suppressed');
  assert.notEqual(status('history-no-disposition', [raised, { result: { findings: [], priorFindingsDisposition: [{ finding: 'Broken acceptance', evidence: 'Looked fine' }] } }]), 'suppressed');
  assert.notEqual(status('history-fixed-without-evidence', [raised, disposed('fixed', ' ')]), 'suppressed');
  assert.notEqual(status('history-fixed-then-remaining', [raised, disposed('fixed'), disposed('remaining', 'Regressed')]), 'suppressed');
  assert.equal(status('history-remaining-then-fixed', [raised, disposed('remaining', 'Not yet'), disposed('fixed')]), 'suppressed');
  finish(f, maintenance('green', 'main.verify', { route: 'pass', mainHealth: { status: 'green' } }));
  assert.ok(!f.store.all('inbox').some(row => row.flowId === 'green'), 'green main verification was already quiet');
});

test('failed, uncertain and repeated stops stay visible once per episode, including self-caused stops', async t => {
  const f = fixture(t); f.start(); f.sent.length = 0;
  for (const [outcome, id] of [['failed', 'failure'], ['uncertain', 'uncertain']]) finish(f, change(id), outcome);
  assert.equal(f.command('stop', { flowId: 'flow-1', note: 'First stop' }, { actor: 'orchestrator' }).status, 'completed');
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'Reconciled' }).status, 'completed');
  assert.equal(f.command('stop', { flowId: 'flow-1', note: 'Second stop' }).status, 'completed');
  queueInbox(f.store); queueInbox(f.store); await f.deliver();
  assert.equal(f.sent.filter(body => body.kind === 'inbox').length, 4);
  assert.ok(!f.sent.some(body => ['flow.stopped', 'flow.resumed', 'flow.finished', 'flow.admitted'].includes(body.event)));
});

test('questions, operator answers and approval changes wake; own resolutions and duplicate state wakes do not', async t => {
  const f = fixture(t), q = f.command('inbox.publish', question).result;
  const own = f.command('inbox.publish', { ...question, id: 'own' }, { actor: 'orchestrator' }).result;
  queueInbox(f.store); await f.deliver();
  assert.deepEqual(f.sent.map(body => body.inboxId), [q.id]);
  assert.equal(f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'b', note: 'Use the reviewed behavior' }).status, 'completed');
  f.command('inbox.withdraw', { inboxId: own.id, expectedVersion: own.version, reason: 'Resolved elsewhere' }, { actor: 'orchestrator' });
  f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }, { commandId: 'approve' });
  f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }, { commandId: 'approve' });
  f.command('task.revoke', { taskId: f.task.id, note: 'Changed decision' });
  queueInbox(f.store); await f.deliver();
  assert.deepEqual(f.sent.slice(1).map(body => body.event).sort(), ['inbox.resolved', 'task.approved', 'task.revoked']);
  assert.equal(f.sent.find(body => body.event === 'inbox.resolved').actor, 'operator');
});

test('changing to actionable filters pending and accepted legacy summaries and state retries without losing attention', async t => {
  for (const status of ['pending', 'accepted', 'sending']) {
    const f = fixture(t, 'all');
    const routine = finish(f, change('routine'));
    delete routine.terminalReason; f.store.put('inbox', routine); // pre-upgrade record
    finish(f, change('actionable', { taskSnapshot: { postMerge: ['Review externally'] } }));
    f.command('inbox.publish', question);
    f.command('task.approve', { taskId: f.task.id, revision: f.task.revision });
    queueInbox(f.store);
    for (const row of f.store.all('delivery')) f.store.put('delivery', { ...row, status, nextAt: new Date(0).toISOString(), leaseUntil: new Date(0).toISOString() });
    const history = f.store.events(), inbox = f.store.all('inbox');
    f.setLevel('actionable'); await f.deliver();
    assert.deepEqual(f.sent.map(body => body.event).sort(), status === 'accepted' ? ['inbox.attention', 'task.approved'] : ['inbox.attention', 'inbox.attention', 'task.approved']);
    assert.ok(!f.sent.some(body => body.inboxId === routine.id));
    assert.deepEqual(f.store.all('inbox'), inbox, 'policy did not resolve or rewrite inbox history');
    assert.deepEqual(f.store.events().filter(row => row.sequence <= history[0].sequence), history);
    f.setLevel('all'); await f.deliver();
    assert.ok(!f.sent.some(body => body.inboxId === routine.id), 'no replay of already suppressed rows');
  }
});

test('queued success resolutions are also filtered; actionable operator resolutions survive a policy change', async t => {
  const f = fixture(t, 'all'), item = finish(f, change('routine'));
  f.command('inbox.ack', { inboxId: item.id });
  const q = f.command('inbox.publish', question).result;
  f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' });
  queueInbox(f.store); f.setLevel('actionable'); await f.deliver();
  assert.deepEqual(f.sent.map(body => [body.inboxId, body.event]), [[q.id, 'inbox.resolved']]);
});

test('state backlog uses retained actor attribution, preserving legacy unknown-actor approvals', async t => {
  const f = fixture(t, 'all');
  for (const [sequence, type, actor] of [[1, 'task.approved', 'orchestrator'], [2, 'task.revoked', 'operator'], [3, 'flow.finished', null]]) {
    f.store.commandActor = actor;
    queueStateDeliveryInTransaction(f.store, { sequence, at: new Date(0).toISOString(), type, payload: { taskId: f.task.id } });
  }
  f.store.commandActor = null;
  f.store.put('delivery', { id: 'legacy', kind: 'state', event: 'task.approval-revoked', taskId: f.task.id, status: 'pending', attempts: 0, nextAt: new Date(0).toISOString() });
  f.setLevel('actionable'); await f.deliver();
  assert.deepEqual(f.sent.map(body => body.event), ['task.revoked', 'task.approval-revoked']);
});

test('only canonical passed obligation evidence can make an ordinary source closure quiet', async t => {
  const f = fixture(t);
  for (const [id, canonical] of [['pending', { status: 'pending' }], ['opaque', { status: 'passed' }], ['proven', { status: 'passed', evidence: 'issue:1' }]]) {
    const obligation = { id: `${id}:close-task`, title: 'Source closure' };
    f.store.put('obligation', { ...obligation, flowId: id, ...canonical });
    finish(f, change(id, { results: { ...change(id).results, post: { obligations: [{ ...obligation, status: 'pending' }] }, close: { route: 'closed', obligations: [{ ...obligation, status: 'passed' }] } } }));
  }
  queueInbox(f.store); await f.deliver();
  assert.deepEqual(f.sent.map(body => f.store.need('inbox', body.inboxId).flowId), ['pending', 'opaque']);
});

test('successful scheduled commands with cleanup obligations and failed attempts remain attention-worthy', async t => {
  const f = fixture(t);
  const scheduled = finish(f, maintenance('scheduled', 'scheduled:inspect', { route: 'pass', exitCode: 0, report: 'Observed files', obligations: [{ title: 'Inspect preserved files' }] }));
  assert.match(scheduled.title, /completed with follow-up/);
  assert.doesNotMatch(scheduled.context, /could not run/);
  f.store.put('attempt', { id: 'failed-close', flowId: 'delivery', status: 'failed' });
  finish(f, change('delivery'));
  queueInbox(f.store); await f.deliver();
  assert.equal(f.sent.length, 2);
});

test('an active send is not recalled but its next accepted retry follows the new policy', async t => {
  const f = fixture(t, 'all'), item = finish(f, change('routine'));
  f.command('inbox.ack', { inboxId: item.id }); queueInbox(f.store);
  for (const row of f.store.all('delivery').filter(row => row.kind === 'state')) f.store.put('delivery', { ...row, status: 'acknowledged' });
  const nowMs = Date.now() + 1000;
  await deliverDue(f.store, { configPath: f.configPath, nowMs, transport: async () => { f.setLevel('actionable'); return { status: 202 }; } });
  assert.equal(f.store.all('delivery').find(row => row.inboxId === item.id).status, 'accepted');
  await f.deliver(nowMs + 1800001);
  assert.equal(f.store.all('delivery').find(row => row.inboxId === item.id).status, 'suppressed');
  assert.deepEqual(f.sent, []);
});
