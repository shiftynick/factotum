import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { sandbox } from './helpers.mjs';
import { stopFlow, move, replanFlow, publicFlow } from '../starter/factory/core/project.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { queueDelivery, deliverDue, acknowledgeDelivery } from '../starter/factory/operations/notifications.mjs';

test('a new stop episode sends a new signed notice after the old stop was acknowledged', async t => {
  const f = sandbox(t); f.start();
  const path = join(f.base, 'notifications.json');
  writeFileSync(path, JSON.stringify({ url: 'https://example.invalid/hook', signingKey: 'fixture-key' }), {mode:0o600});
  const stopped = () => f.store.tx(() => stopFlow(f.store, f.store.need('flow', 'flow-1'), 'Same failure'));
  stopped(); const first = f.store.all('inbox').find(i => i.kind === 'notice');
  const delivery = queueDelivery(f.store, { inboxId: first.id });
  acknowledgeDelivery(f.store, { deliveryId: delivery.id });
  f.command('inbox.ack', { inboxId: first.id });
  stopped(); assert.equal(f.store.all('inbox').filter(i => i.kind === 'notice').length, 1, 'repeated observation is quiet');
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'Try again' }).status, 'completed');
  stopped(); const second = f.store.all('inbox').find(i => i.kind === 'notice' && i.id !== first.id);
  assert.ok(second); assert.equal(second.status, 'open');
  assert.equal(f.store.need('inbox', first.id).status, 'acknowledged');
  const fresh = queueDelivery(f.store, { inboxId: second.id }); assert.notEqual(fresh.id, delivery.id);
  const sent = [];
  await deliverDue(f.store, { configPath: path, nowMs: Date.now() + 1000, transport: async request => {
    assert.equal(request.headers['x-factotum-signature'], createHmac('sha256', 'fixture-key').update(request.payload).digest('hex'));
    sent.push(JSON.parse(request.payload)); return { status: 202 };
  } });
  assert.equal(sent.length, 1); assert.equal(sent[0].inboxId, second.id);
  stopped(); assert.equal(f.store.all('inbox').filter(i => i.kind === 'notice').length, 2);
});

test('a legacy acknowledged stop gets a distinct notice after recovery', t => {
  const f = sandbox(t); f.start();
  f.store.tx(() => stopFlow(f.store, f.store.need('flow', 'flow-1'), 'Same failure'));
  const old = f.store.need('flow', 'flow-1'); delete old.stopSequence; f.store.put('flow', old);
  f.command('inbox.ack', { inboxId: f.store.all('inbox')[0].id });
  // Legacy notice IDs omit the sequence; use the canonical publisher to reproduce it.
  const oldId = f.store.all('inbox')[0].id;
  f.store.db.prepare("DELETE FROM records WHERE kind='inbox' AND id=?").run(oldId);
  f.store.tx(() => stopFlow(f.store, old, 'Same failure'));
  const legacy = f.store.all('inbox')[0]; f.command('inbox.ack', { inboxId: legacy.id });
  f.command('resume', { flowId: old.id, note: 'Resume legacy flow' });
  f.store.tx(() => stopFlow(f.store, f.store.need('flow', old.id), 'Same failure'));
  assert.equal(f.store.all('inbox').length, 2);
  assert.equal(f.store.need('inbox', legacy.id).status, 'acknowledged');
});

test('repeated replans grant exactly fresh bounded cycles and preserve cumulative visits', t => {
  const f = sandbox(t), workflow = changeWorkflow({policy:{}});
  // Give the review step a project-defined bound too, to exercise both accounting styles.
  // The plan bound is pinned at 2 (the reference default is 3 from dev.82) so the exhaustion below stays exact.
  workflow.nodes['plan-review'].maxVisits = 2; workflow.nodes.plan.maxVisits = 2;
  const flow = { id:'cycles', taskId:f.task.id, kind:'change', workflow, step:'plan-review', state:'stopped', stopRequested:true, stopReason:'old', resumeStep:'failed', transitions:8, visits:{plan:3,'plan-review':2}, results:{}, evidence:{}, sessions:{} };
  for (let cycle = 0; cycle < 3; cycle++) {
    const prior = {...flow.visits};
    f.store.tx(() => replanFlow(f.store, flow, {note:'Reviewed findings; retry', by:'operator'}));
    assert.equal(flow.visits.plan, prior.plan + 1); assert.equal(flow.visits['plan-review'], prior['plan-review']);
    assert.equal(flow.resumeStep, undefined); assert.equal(flow.stopReason, undefined);
    assert.deepEqual(publicFlow(flow).visitBudgets.plan, {allowance:2,used:1,remaining:1,cumulative:prior.plan+1});
    for (const step of ['plan-review','plan','plan-review']) move(f.store,flow,step);
    const before = structuredClone(flow);
    assert.throws(() => move(f.store,flow,'plan'), /visit bound exhausted at plan/);
    assert.deepEqual(flow,before,'a rejected transition consumes neither visits nor transitions');
    assert.equal(publicFlow(flow).visitBudgets['plan-review'].remaining,0);
    assert.throws(() => move(f.store,flow,'plan-review'), /visit bound exhausted at plan-review/);
  }
  flow.transitions = (workflow.maxTransitions ?? 100) + flow.transitionAllowance;
  const before = structuredClone(flow);
  assert.throws(() => move(f.store,flow,'plan'), /transition bound exhausted before plan/);
  assert.deepEqual(flow,before,'a rejected transition bound also leaves counters unchanged');
});
