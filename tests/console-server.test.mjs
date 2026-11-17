import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startConsole, registerProject, unregisterProject } from '../starter/factory/console/console.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-console-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fake(t, dir, projectId, options = {}) {
  const socketPath = join(dir, `${projectId}-${Math.random().toString(36).slice(2)}.sock`);
  const receipts = new Map();
  const calls = [];
  const handshake = { protocolVersion: 1, projectId, serviceId: `service-${projectId}`, name: `Project ${projectId}`, stateRevision: 1, capabilities: ['snapshot', 'command', 'commandStatus'] };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/handshake') return send(200, handshake);
    if (req.url === '/v1/snapshot') {
      if (options.hangSnapshot) return;
      return send(200, { projectId, name: handshake.name, revision: 1, paused: false, tasks: [], flows: [], inbox: [] });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/commands/')) {
      const receipt = receipts.get(decodeURIComponent(req.url.slice('/v1/commands/'.length)));
      return send(receipt ? 200 : 404, receipt || { error: 'Unknown command' });
    }
    if (req.method === 'POST' && req.url === '/v1/commands') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); calls.push(body);
      const receipt = { projectId, commandId: body.commandId, status: 'completed', result: { paused: body.payload.paused } };
      receipts.set(body.commandId, receipt);
      if (options.loseResponse) return req.socket.destroy();
      return send(200, receipt);
    }
    send(404, { error: 'Missing route' });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await new Promise(resolve => server.close(resolve)); } };
  t.after(close);
  return { socketPath, receipts, calls, handshake, close };
}
async function launch(t, stateDir) {
  // Only a project that never answers should reach this bound; healthy fakes answer well within it on a loaded host.
  const instance = await startConsole({ stateDir, timeoutMs: 3000 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await instance.close(); } };
  t.after(close);
  const initial = await fetch(instance.url);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const csrf = (await initial.text()).match(/name="factotum-csrf" content="([^"]+)"/)[1];
  const request = (path, body, extra = {}) => fetch(`${instance.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-factotum-csrf': csrf }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...instance, close, request, csrf, cookie };
}
const pause = binding => ({ projectId: binding.projectId, bindingId: binding.bindingId, commandId: 'command-1', operation: 'pause', payload: { paused: true, note: 'Test' }, actor: 'operator' });

test('immutable routing, duplicate IDs and content-bound command identity', async t => {
  const dir = await setup(t);
  const a = await fake(t, dir, 'a'); const b = await fake(t, dir, 'b');
  const stateDir = join(dir, 'private');
  const bindingA = await registerProject(stateDir, a);
  const bindingB = await registerProject(stateDir, b);
  await assert.rejects(registerProject(stateDir, a), /already registered/);
  const duplicate = await fake(t, dir, 'a');
  await assert.rejects(registerProject(stateDir, duplicate), /already registered/);
  const app = await launch(t, stateDir);
  assert.equal((await app.request('/api/commands', { ...pause(bindingA), bindingId: bindingB.bindingId })).status, 409);
  assert.equal(a.calls.length + b.calls.length, 0);
  const first = await (await app.request('/api/commands', pause(bindingA))).json();
  assert.equal(first.status, 'completed');
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 0);
  assert.equal((await app.request('/api/commands', pause(bindingA))).status, 200);
  assert.equal(a.calls.length, 1);
  assert.equal((await app.request('/api/commands', { ...pause(bindingA), payload: { paused: false } })).status, 409);
  const simultaneous = { ...pause(bindingA), commandId: 'simultaneous' };
  await Promise.all([app.request('/api/commands', simultaneous), app.request('/api/commands', simultaneous)]);
  assert.equal(a.calls.length, 2, 'Concurrent duplicate submissions dispatch only once');
  const publicProjects = await (await app.request('/api/projects')).text();
  const publicJournal = await (await app.request('/api/journal')).text();
  assert.ok(!publicProjects.includes(a.socketPath)); assert.ok(!publicJournal.includes(a.socketPath));
});

test('response loss is reconciled after restart, without dispatching again', async t => {
  const dir = await setup(t);
  const service = await fake(t, dir, 'a', { loseResponse: true });
  const stateDir = join(dir, 'private');
  const binding = await registerProject(stateDir, service);
  const first = await launch(t, stateDir);
  const result = await (await first.request('/api/commands', pause(binding))).json();
  assert.equal(result.status, 'unknown'); assert.equal(service.calls.length, 1);
  await first.close();
  const second = await launch(t, stateDir);
  const reconciled = await second.reconcile();
  assert.equal(reconciled[0].status, 'completed');
  assert.equal(reconciled[0].commandId, 'command-1');
  assert.equal(service.calls.length, 1);
});

test('journal before dispatch survives unregistration and restart without offline execution', async t => {
  const dir = await setup(t);
  const service = await fake(t, dir, 'a'); const stateDir = join(dir, 'private');
  const binding = await registerProject(stateDir, service);
  const db = new DatabaseSync(join(stateDir, 'console.sqlite'));
  const state = JSON.parse(db.prepare('SELECT value FROM console_state WHERE id=1').get().value);
  state.journal.push({ ...binding, socketPath: service.socketPath, commandId: 'not-dispatched', digest: 'example', submittedAt: new Date().toISOString(), status: 'unknown' });
  db.prepare('UPDATE console_state SET value=? WHERE id=1').run(JSON.stringify(state));
  db.close();
  unregisterProject(stateDir, binding.projectId);
  const replacement = await fake(t, dir, 'a');
  const newBinding = await registerProject(stateDir, replacement);
  assert.notEqual(newBinding.bindingId, binding.bindingId);
  const app = await launch(t, stateDir);
  const result = await app.reconcile();
  assert.equal(result[0].status, 'unknown');
  assert.match(result[0].detail, /not resubmitted/);
  assert.equal(service.calls.length + replacement.calls.length, 0);
  assert.equal((await app.request('/api/commands', pause(binding))).status, 409);
});

test('unavailable, incompatible and identity-mismatched projects leave healthy projects usable', async t => {
  const dir = await setup(t); const stateDir = join(dir, 'private');
  const good = await fake(t, dir, 'good'); const offline = await fake(t, dir, 'offline');
  const incompatible = await fake(t, dir, 'incompatible'); const wrong = await fake(t, dir, 'wrong');
  const slow = await fake(t, dir, 'slow', { hangSnapshot: true });
  for (const service of [good, offline, incompatible, wrong, slow]) await registerProject(stateDir, service);
  await offline.close(); incompatible.handshake.protocolVersion = 99; wrong.handshake.projectId = 'unexpected';
  const app = await launch(t, stateDir);
  const projects = await (await app.request('/api/projects')).json();
  assert.equal(projects.find(project => project.projectId === 'good').status, 'available');
  assert.equal(projects.find(project => project.projectId === 'offline').status, 'unavailable');
  assert.equal(projects.find(project => project.projectId === 'incompatible').status, 'incompatible');
  assert.equal(projects.find(project => project.projectId === 'slow').status, 'unavailable');
  assert.match(projects.find(project => project.projectId === 'wrong').error, /identity mismatch/);
  assert.ok(!JSON.stringify(projects).includes(offline.socketPath));
});

test('loopback console rejects foreign origins and missing session or CSRF', async t => {
  const dir = await setup(t); const app = await launch(t, join(dir, 'private'));
  assert.equal((await fetch(`${app.url}/api/projects`)).status, 403);
  assert.equal((await app.request('/api/projects', undefined, { origin: 'http://other.invalid' })).status, 403);
  assert.equal((await app.request('/api/commands', {}, { 'x-factotum-csrf': '' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${app.url}/api/projects`, { headers: { host: 'attacker.invalid', cookie: app.cookie } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  await assert.rejects(startConsole({ stateDir: join(dir, 'other'), host: '0.0.0.0' }), /loopback/);
});
