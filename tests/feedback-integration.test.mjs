import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { operationalTick, runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';

function configureAudit(f) {
  const remote=join(f.base,'audit-remote.git');
  execFileSync('git',['branch','-M','main'],{cwd:f.root});
  execFileSync('git',['clone','--bare','--quiet',f.root,remote]);
  execFileSync('git',['remote','add','origin',remote],{cwd:f.root});
  return {version:1,mode:'delivery',repository:{slug:'fictional/audit',account:'fictional',target:'main',remote:'origin'},providers:{reviewer:{provider:'claude',model:'fictional'}},policy:{autoQueue:false},context:{files:[],maxChars:1000}};
}
async function auditThroughEngine(f) {
  const job = f.command('job.enqueue', { operation: 'audit', note: 'Inspect the fictional baseline without granting implementation authority' }).result;
  await operationalTick(f.store);
  const flow = f.store.need('flow', f.store.need('job', job.id).flowId);
  await f.engine.tick();
  const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  assert.equal(attempt.intent.action.operation, 'audit');
  const result = await runMaintenanceAction(attempt.intent, { providerInvoke: async () => ({ provider: 'claude', result: { verdict: 'revise', summary: 'One fictional improvement', findings: [{ severity: 'low', file: 'input.txt', line: 1, message: 'Describe the fictional baseline more precisely' }] } }) });
  f.engine.settle(flow.id, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), actionResult: result });
  await f.engine.tick();
  assert.equal(f.store.need('flow', flow.id).state, 'completed');
  return { flow, attempt, result };
}
test('actual repeated maintenance audit settles one durable unapproved finding and preserves resolved obligation', async t => {
  const f = sandbox(t), config = configureAudit(f);
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const first = await auditThroughEngine(f);
  assert.equal(f.store.all('finding').length, 1);
  const finding = f.store.all('finding')[0]; assert.equal(finding.status, 'unapproved'); assert.ok(finding.evidenceDigest);
  const obligation = f.store.all('obligation').find(row => row.title === finding.title);
  assert.ok(obligation, 'settled verified findings must become visible bounded follow-ups');
  f.command('obligation.resolve', { obligationId: obligation.id, status: 'passed', evidence: 'Fictional operator disposition', note: 'Record the inspected finding disposition' });
  const second = await auditThroughEngine(f);
  assert.notEqual(first.attempt.id, second.attempt.id);
  assert.equal(first.result.findings[0].id, second.result.findings[0].id, 'finding identity must depend on actual code evidence, not attempt identity');
  assert.equal(f.store.all('finding').length, 1); assert.equal(f.store.all('finding')[0].observations, 2); assert.equal(f.store.all('obligation').length, 1);
  assert.equal(f.store.need('obligation', obligation.id).status, 'passed', 'reobservation must not reopen a resolved follow-up');
  assert.equal(snapshot(f.store).findings.length, 1);
});
test('canonical rule pushback is visible after restart and grants no policy or work authority', async t => {
  const f = sandbox(t), beforeConfig = f.store.meta('config'), beforeApproval = f.store.need('task', f.task.id).approvedRevision;
  const operator = f.command('rule.pushback', { ruleId: 'review.max-rounds', reason: 'The fictional change needs a documented exception', evidence: 'Retained fictional review evidence' });
  assert.equal(operator.status, 'completed'); assert.equal(operator.result.status, 'proposed');
  const orchestrator = f.command('rule.pushback', { ruleId: 'review.max-rounds', reason: 'The fictional policy may need improvement', evidence: 'Retained fictional review evidence' }, { actor: 'orchestrator' });
  assert.equal(orchestrator.status, 'completed');
  assert.deepEqual(f.store.meta('config'), beforeConfig); assert.equal(f.store.need('task', f.task.id).approvedRevision, beforeApproval); assert.equal(f.store.all('flow').length, 0);
  assert.equal(snapshot(f.store).pushback.length, 2);
  const { Store } = await import('../starter/factory/core/store.mjs'); const reopened = new Store(f.stateDir);
  try { assert.equal(snapshot(reopened).pushback.length, 2); } finally { reopened.close(); }
  assert.equal(f.command('rule.pushback', { ruleId: 'review.max-rounds', flowId: 'missing', reason: 'Fictional reason', evidence: 'Fictional evidence' }).status, 'rejected');
});
test('Linux machine sample parses only aggregates and actual maintenance settlement retains them', async t => {
  const { parseMachineSample, sampleMachine } = await import('../starter/factory/operations/sampling.mjs');
  const fixtures = { '/proc/loadavg': '1.25 2.50 3.75 4/500 999999\n', '/proc/meminfo': 'MemTotal:       8192 kB\nMemAvailable:   2048 kB\nSwapTotal: 123 kB\n', '/proc/uptime': '123.50 999.0\n' };
  const fixed = sampleMachine({ read: path => fixtures[path], observedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(fixed, { observedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 123.5, loadAverage: [1.25, 2.5, 3.75], memoryBytes: { total: 8192 * 1024, available: 2048 * 1024 } });
  assert.throws(() => parseMachineSample({ loadavg: 'NaN 2 3', meminfo: fixtures['/proc/meminfo'], uptime: '1' }), /load averages/);
  assert.throws(() => parseMachineSample({ loadavg: '1 2 3', meminfo: 'MemTotal: 1 kB\nMemAvailable: 2 kB', uptime: '1' }), /memory aggregates/);
  const host = sampleMachine(); assert(Number.isFinite(host.uptimeSeconds)); assert(host.memoryBytes.total >= host.memoryBytes.available); assert.equal(host.loadAverage.length, 3);
  const f = sandbox(t), config = { version: 1, mode: 'delivery', policy: { autoQueue: false }, context: { files: [], maxChars: 1000 } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const job = f.command('job.enqueue', { operation: 'machine.sample', note: 'Collect numeric machine capacity for the fictional factory' }).result;
  await operationalTick(f.store); const flow = f.store.need('flow', f.store.need('job', job.id).flowId); await f.engine.tick();
  const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId), result = await runMaintenanceAction(attempt.intent, { machineRead: path => fixtures[path] });
  f.engine.settle(flow.id, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: result });
  const projection = snapshot(f.store); assert.equal(projection.machineSamples.length, 1); assert.deepEqual(projection.machineSamples[0].loadAverage, [1.25, 2.5, 3.75]);
});

test('explicit maintenance retrospective persists the selected actual flow report', async t => {
  const f = sandbox(t), config = configureAudit(f);
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const first = await auditThroughEngine(f);
  f.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('retrospective', first.flow.id);
  const job = f.command('job.enqueue', { operation: 'retrospective', payload: { flowId: first.flow.id }, note: 'Reconstruct the actual completed flow report' }).result;
  await operationalTick(f.store); const flow = f.store.need('flow', f.store.need('job', job.id).flowId); await f.engine.tick();
  const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId), result = await runMaintenanceAction(attempt.intent);
  assert.equal(result.retrospective.flowId, first.flow.id);
  assert.equal(f.store.need('retrospective', first.flow.id).contentDigest, result.retrospective.contentDigest);
  f.engine.settle(flow.id, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: result });
  assert(snapshot(f.store).retrospectives.some(report => report.flowId === first.flow.id));
});
