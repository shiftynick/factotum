import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS } from '../starter/factory/core/command-help.mjs';

// The T3 guide and its project template are followed literally by a fresh orchestrator thread:
// every operation and payload field they name must exist.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const GUIDES = { 'docs/integrations/t3.md': read('../docs/integrations/t3.md'), 'starter/project/integrations/t3-notifications.example.md': read('../starter/project/integrations/t3-notifications.example.md') };

test('the T3 guides name only real operations and payload fields', () => {
  for (const [name, text] of Object.entries(GUIDES)) {
    const operations = [...text.matchAll(/--operation ([a-z][a-z.]*)/g)].map(m => m[1]);
    assert.ok(operations.length > 0, `${name} names operations`);
    assert.deepEqual(operations.filter(op => !COMMANDS[op]), [], `${name} names unknown operations`);
    // Payloads given inline: each key must be a field of that operation.
    for (const m of text.matchAll(/--operation ([a-z.]+) --payload '(\{[^']*\})'/g)) {
      const fields = new Set(COMMANDS[m[1]][1].map(([field]) => field));
      const keys = [...m[2].matchAll(/"([a-zA-Z]+)":/g)].map(k => k[1]).filter(k => !['quote', 'channel'].includes(k));
      assert.deepEqual(keys.filter(k => !fields.has(k)), [], `${name}: ${m[1]} payload names unknown fields`);
    }
    assert.doesNotMatch(text, /update_scheduled_task/, `${name} names a T3 tool that does not exist`);
  }
});

test('the T3 setup states what Factotum signs and keeps the orchestrator from answering for the operator', () => {
  const guide = GUIDES['docs/integrations/t3.md'];
  const source = read('../starter/factory/operations/notifications.mjs');
  assert.match(source, /'x-factotum-signature': createHmac\('sha256', config\.signingKey\)\.update\(payload\)\.digest\('hex'\)/);
  assert.match(guide, /"header": "x-factotum-signature", "encoding": "hex", "prefix": ""/);
  assert.match(guide, /never `respond` to it/);
  assert.match(guide, /\*\*Off by default \(operator decision, 2026-11-15\)\.\*\*/);
  assert.match(guide, /\*\*Failed in that environment:\*\* a child's question reaching the human/);
  // Off by default (dev.85): the template's ask-prompt section is optional, and its template note says to delete it unless the route was confirmed.
  const handling = GUIDES['starter/project/integrations/t3-notifications.example.md'];
  assert.match(handling, /<!-- optional: ask-prompt -->\n## Asking through the ask prompt\n/);
  assert.match(handling, /`optional: ask-prompt` \("Asking through the ask prompt"\): delete it unless the user has confirmed/);
  assert.doesNotMatch(handling, /Leave this section out/);
});

test('the starter state filter keeps every hold, fault, open question and the flow evidence a decision needs', async t => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('jq', ['--version'], { stdio: 'ignore' }); } catch { t.skip('jq is not installed'); return; }
  const { sandbox } = await import('./helpers.mjs');
  const { snapshot } = await import('../starter/factory/core/project.mjs');
  const { recordOperationsFault } = await import('../starter/factory/operations/recovery-hold.mjs');
  const f = sandbox(t), store = f.store;
  f.start();
  const ask = title => f.command('inbox.publish', { kind: 'question', title, context: 'Fictional context.', question: `${title}?`, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }).result;
  const woken = ask('Fictional question one'), other = ask('Fictional question two');
  store.tx(() => {
    const flow = store.need('flow', 'flow-1');
    Object.assign(flow, { effectiveRisk: 'strict', attemptId: 'attempt-gate', results: {
      review: { route: 'revise', attemptId: 'attempt-review', identity: { head: 'a'.repeat(40) }, result: { verdict: 'revise', findings: [{ severity: 'high', file: 'src/a.js', line: 3, message: 'Fictional finding' }] } },
      gate: { route: 'fail', attemptId: 'attempt-gate', inputIdentity: { head: 'a'.repeat(40) }, checks: [{ id: 'unit', status: 'failed' }] } } });
    store.put('flow', flow);
    store.put('attempt', { id: 'attempt-gate', flowId: 'flow-1', step: 'gate', status: 'failed', reservedMicros: 0 });
    store.setMeta('retentionHold', { operationId: 'retention-1' }); store.setMeta('moneyHold', true);
    store.setMeta('notificationHealth', { status: 'paused', problem: 'not a private 0600 file', since: new Date().toISOString() });
  });
  recordOperationsFault(store, new Error('fictional ordinary fault'));
  recordOperationsFault(store, Object.assign(new Error('disk I/O error'), { errcode: 10 }));
  const out = execFileSync('jq', ['-c', '--arg', 'inbox', woken.id, '--arg', 'flow', '', '--arg', 'task', '', '-f', new URL('../starter/project/integrations/factotum-state.example.jq', import.meta.url).pathname], { input: JSON.stringify(snapshot(store)), encoding: 'utf8' });
  const state = JSON.parse(out);
  assert.equal(state.project.recoveryHold, true);
  assert.equal(state.project.recoveryHoldReason.cause, 'operations-fault');
  assert.equal(state.project.holds.retentionHold, true); assert.equal(state.project.holds.moneyHold, true); assert.ok('providerHolds' in state.project.holds);
  assert.deepEqual(state.project.queueHolds.map(h => h.kind).filter(k => ['recovery', 'retention', 'money'].includes(k)).sort(), ['money', 'recovery', 'retention']);
  assert.equal(state.project.health.operationsFault.error, 'fictional ordinary fault');
  assert.equal(state.project.health.notifications.status, 'paused');
  assert.ok(state.recentFaults.some(e => e.type === 'operations.fault' && e.payload.recoveryHold === true), 'the fault that placed the hold');
  assert.deepEqual(state.openItems.map(i => i.id).filter(id => [woken.id, other.id].includes(id)).sort(), [woken.id, other.id].sort(), 'other open questions');
  assert.equal(state.item.id, woken.id);
  assert.ok(JSON.stringify(state).length < 20000, 'compact');
  // Without a flow in the wake, name the flow: risk, attempt and evidence survive.
  const flowState = JSON.parse(execFileSync('jq', ['-c', '--arg', 'inbox', '', '--arg', 'flow', 'flow-1', '--arg', 'task', '', '-f', new URL('../starter/project/integrations/factotum-state.example.jq', import.meta.url).pathname], { input: JSON.stringify(snapshot(store)), encoding: 'utf8' }));
  assert.equal(flowState.flow.effectiveRisk, 'strict'); assert.equal(flowState.flow.attemptId, 'attempt-gate');
  assert.equal(flowState.flow.evidence.review.verdict, 'revise'); assert.equal(flowState.flow.evidence.review.findings[0].message, 'Fictional finding');
  assert.equal(flowState.flow.evidence.review.head, 'a'.repeat(40));
  assert.deepEqual(flowState.flow.evidence.gate.checks, [{ id: 'unit', status: 'failed' }]);
  assert.ok(flowState.attempts.some(a => a.id === 'attempt-gate' && a.status === 'failed'));
  assert.equal(flowState.task.id, 'task-1');
});

// The triage proxy section and its starter guide name operations, webhook events and payload
// fields by hand: each must be a real command, a real event or a field the real payload carries.
test('the triage proxy guidance names only real operations, events and payload fields', async t => {
  const guide = GUIDES['docs/integrations/t3.md'];
  const proxy = read('../starter/project/integrations/t3-triage.example.md');
  const source = read('../starter/factory/operations/notifications.mjs');
  const stateEvents = JSON.parse(source.match(/const stateEvents=new Set\((\[[^\]]*\])\)/)[1].replaceAll("'", '"'));
  const events = new Set(['inbox.attention', 'inbox.resolved', ...stateEvents]);
  const section = guide.slice(guide.indexOf('## Triage proxy thread (recommended)'), guide.indexOf('## Handling wakes'));
  assert.ok(section.length > 1000, 'the guide has the triage proxy section');
  const handling = GUIDES['starter/project/integrations/t3-notifications.example.md'];
  for (const [name, text] of Object.entries({ section, proxy, handling: handling.slice(handling.indexOf('## Forwards from the triage proxy'), handling.indexOf('## kind = state')) })) {
    const named = [...text.matchAll(/`((?:inbox|delivery|orchestrator|task|queue|flow|planning)\.[a-z.-]+)/g)].map(m => m[1]);
    assert.ok(named.length > 0, `${name} names operations`);
    assert.deepEqual(named.filter(op => !COMMANDS[op] && !events.has(op)), [], `${name} names unknown operations or events`);
  }
  // Payload fields: from payloads the real delivery code sends, inbox (with a resolution and a
  // presentation-end wake) and state alike.
  const { sandbox } = await import('./helpers.mjs');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { deliverDue, queueDelivery, wakePresenterInTransaction } = await import('../starter/factory/operations/notifications.mjs');
  const f = sandbox(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level: 'all', configPath } });
  const ok = (op, payload, actor = 'operator') => { const r = f.command(op, payload, { actor }); assert.equal(r.status, 'completed', JSON.stringify(r)); return r.result; };
  const q = ok('inbox.publish', { kind: 'question', title: 'Fictional', context: 'Fictional.', question: 'Fictional?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const shown = ok('inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: 't3-ask', expiryMs: 60000 }, 'orchestrator').presentation;
  f.store.tx(() => wakePresenterInTransaction(f.store, f.store.need('inbox', q.id), shown));
  ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  ok('flow.start', { taskId: f.task.id, flowId: 'flow-1' });
  const deliver = async nowMs => { for (const row of f.store.all('inbox')) queueDelivery(f.store, { inboxId: row.id }); await deliverDue(f.store, { configPath, nowMs, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } }); };
  await deliver(Date.now() + 1000);
  ok('answer', { inboxId: q.id, version: f.store.need('inbox', q.id).version, subjectDigest: f.store.need('inbox', q.id).subjectDigest, answer: 'a' });
  await deliver(Date.now() + 2000);
  const fields = new Set(sent.flatMap(body => Object.keys(body)));
  for (const field of ['presentationEnded', 'resolution', 'actor', 'taskRevision', 'eventSequence', 'flowId']) assert.ok(fields.has(field), `fixture covers ${field}`);
  for (const [name, text] of Object.entries({ guide })) {
    const placeholders = [...text.matchAll(/\{\{body\.([a-zA-Z]+)\}\}/g)].map(m => m[1]);
    assert.deepEqual([...new Set(placeholders.filter(field => !fields.has(field)))], [], `${name} prompts name fields no payload carries`);
  }
  // The proxy prompt carries every field the triage rules read.
  const proxyPrompt = section.match(/```text\nFactotum webhook for the triage proxy[^\n]*/)[0];
  for (const field of ['projectId', 'deliveryId', 'kind', 'event', 'inboxId', 'version', 'resolution', 'actor', 'presentationEnded', 'taskId', 'flowId', 'taskRevision']) assert.match(proxyPrompt, new RegExp(`"${field}":"\\{\\{body\\.${field}\\}\\}"`));
  // The proxy forwards to the bound session, as both reads report it.
  const { stateView } = await import('../starter/factory/operations/state-view.mjs');
  const { dashboardSnapshot } = await import('../starter/factory/service/dashboard.mjs');
  ok('orchestrator.session', { sessionId: 'fictional-orchestrator-thread' }, 'orchestrator');
  assert.equal(stateView(f.store, { inbox: q.id }).project.session.sessionId, 'fictional-orchestrator-thread');
  assert.equal(dashboardSnapshot(f.store).orchestratorSession.sessionId, 'fictional-orchestrator-thread');
  assert.match(section, /`project\.session\.sessionId`/); assert.match(section, /`orchestratorSession\.sessionId`/);
  // The recommendation and the limits on the proxy stay stated.
  assert.match(section, /\*\*The session binding: the orchestrator binds, the proxy never does\.\*\*/);
  assert.match(section, /never answers anything on the operator's behalf/);
  assert.match(proxy, /bind `orchestrator\.session`/);
  assert.match(guide, /\*\*Off by default \(operator decision, 2026-11-15\)\.\*\*/, 'the ask prompt stays off by default');
});
