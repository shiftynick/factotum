import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { STATS_FIELDS, startConsole, registerProject } from '../starter/factory/console/console.mjs';

// A trial found three documented Stats sections missing in a real console: the console backend
// dropped `accounting` and `providerLimits` from the stats response, and the dashboard snapshot
// it polls had no `orchestratorSession`.

test('the console forwards every top-level field the service returns for Stats', t => {
  const f = sandbox(t);
  for (const window of ['7d', '30d', '12w']) {
    const keys = ['projectId', ...Object.keys(projectStats(f.store, { window }))];
    const dropped = keys.filter(key => !STATS_FIELDS.includes(key));
    assert.deepEqual(dropped, [], `the console would drop ${dropped.join(', ')} from /v1/stats/${window}`);
  }
});

test('the dashboard snapshot carries the orchestrator session the Stats page renders', t => {
  const f = sandbox(t);
  assert.equal(dashboardSnapshot(f.store).orchestratorSession.sessionId, null);
  f.command('orchestrator.session', { sessionId: 'fictional-session' });
  const session = dashboardSnapshot(f.store).orchestratorSession;
  assert.equal(session.sessionId, 'fictional-session'); assert.equal(session.version, 1);
});

test('a stats read through the console backend keeps accounting and provider limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fct-stats-')); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'service.sock'), stateDir = join(root, 'private');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local'); let body;
    if (url.pathname === '/v1/handshake') body = { projectId: 'alpha', serviceId: 'service-alpha', protocolVersion: 1, name: 'Fictional alpha', capabilities: ['snapshot', 'command', 'commandStatus'] };
    else if (url.pathname === '/v1/stats/7d') body = { projectId: 'alpha', window: '7d', accounting: { version: 1 }, providerLimits: { held: [] }, private: 'NOT-FORWARDED' };
    else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(socketPath, r)); t.after(() => new Promise(r => server.close(r)));
  const binding = await registerProject(stateDir, { socketPath }, { timeoutMs: 2000 });
  const app = await startConsole({ stateDir, timeoutMs: 2000 }); t.after(() => app.close());
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const response = await fetch(`${app.url}/api/project/alpha/stats/7d?bindingId=${encodeURIComponent(binding.bindingId)}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.accounting, { version: 1 }); assert.deepEqual(data.providerLimits, { held: [] }); assert.equal(data.private, undefined);
});
