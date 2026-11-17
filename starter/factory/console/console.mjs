import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestProject } from './client.mjs';
// Every top-level field of the service's /v1/stats/<window> response the Stats page renders.
export const STATS_FIELDS = Object.freeze(['projectId','window','observedAt','few','synthetic','throughput','quality','estimate','accounting','checks','decisions','models','maintenance','backlog','failures','flows','providerLimits','upkeep']);

const assets = fileURLToPath(new URL('./', import.meta.url));
const supported = ['grant.issue','grant.revoke','decision.relay','decision.open','decision.present','decision.dispose','decision.revoke','decision.ratify','task.restart','settings.update','models.update','doctor.request','task.label','task.models','task.schedule','schedule.pause','recurring.run','job.enqueue','operator.presence','inbox.publish','inbox.withdraw','inbox.present','inbox.unpresent','pause','stop','stop.all','resume','answer','task.put','task.approve','task.revoke','flow.start','rule.pushback','regression.record','queue.put','main.health','schedule.put','schedule.remove','delivery.ack','obligation.resolve','finding.accept','finding.resolve','finding.reopen','upkeep.lift','flow.replan','flow.note','inbox.read','inbox.ack'];
const collections = new Set(['grant','decision','task','flow','inbox','attempt','schedule','event','delivery','obligation','finding','pushback','regression','machineSample','wait','queue','retrospective','context','command','mainCheckObservation']);
// Static browser assets are a fixed allowlist; request paths never select arbitrary files.
const staticAssets = new Map([['/ui.mjs', 'ui.mjs'], ['/style.css', 'style.css'], ...['dom', 'state', 'presence', 'actions', 'overview', 'inbox', 'timeline', 'plan','queue', 'scheduled', 'history', 'stats', 'operations', 'settings', 'receipts', 'records', 'admission'].map(name => [`/ui/${name}.mjs`, `ui/${name}.mjs`])]);
const artifactNames = new Set(['stdout.log','stderr.log','action-result.json','provider/stdout.jsonl','provider/stderr.txt','provider/result.json','provider/output-schema.json','provider/prompt.txt']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
// A read route's subject: a record id Factotum generated (core/contracts.mjs recordId: up to 640
// characters, "/" from a target branch name in a maintenance job id), a collection or a window (dev.86, J8).
const subjectId = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,640}$/.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function database(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = resolve(stateDir, 'console.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout=1500; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS console_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO console_state (id,value) VALUES (1,?)').run(JSON.stringify({ version: 1, bindings: [], journal: [] }));
  return db;
}
function readState(stateDir) {
  const db = database(stateDir);
  try { return JSON.parse(db.prepare('SELECT value FROM console_state WHERE id=1').get().value); }
  finally { db.close(); }
}
function mutateState(stateDir, update) {
  const db = database(stateDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    const state = JSON.parse(db.prepare('SELECT value FROM console_state WHERE id=1').get().value);
    const result = update(state);
    db.prepare('UPDATE console_state SET value=? WHERE id=1').run(JSON.stringify(state));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

function publicBinding({ projectId, serviceId, bindingId, name }) { return { projectId, serviceId, bindingId, name }; }
function publicEntry({ socketPath, ...entry }) { return entry; }
function checkHandshake(handshake, expected) {
  if (!id(handshake.projectId) || !id(handshake.serviceId) || typeof handshake.name !== 'string') throw fail('Invalid project handshake');
  if (expected && (handshake.projectId !== expected.projectId || handshake.serviceId !== expected.serviceId)) throw fail('Project identity mismatch', 409);
  if (handshake.protocolVersion !== 1 || !['snapshot', 'command', 'commandStatus'].every(cap => handshake.capabilities?.includes(cap))) throw fail('Incompatible project protocol', 409);
  return handshake;
}

/** Endpoints are operator-configured private paths, never browser input. */
export async function registerProject(stateDir, { socketPath }, { timeoutMs = 1500 } = {}) {
  if (!isAbsolute(socketPath || '')) throw fail('An absolute Unix socket path is required');
  const handshake = checkHandshake(await requestProject(socketPath, { path: '/v1/handshake', timeoutMs }));
  return mutateState(stateDir, state => {
    if (state.bindings.some(binding => binding.active && (binding.projectId === handshake.projectId || binding.serviceId === handshake.serviceId || binding.socketPath === socketPath))) throw fail('Project, service or endpoint is already registered', 409);
    const binding = { ...publicBinding(handshake), bindingId: randomUUID(), socketPath, active: true };
    state.bindings.push(binding);
    return publicBinding(binding);
  });
}

export function unregisterProject(stateDir, projectId) {
  mutateState(stateDir, state => {
    const binding = state.bindings.find(item => item.active && item.projectId === projectId);
    if (!binding) throw fail('Unknown project', 404);
    binding.active = false;
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function receiptValid(receipt, entry) {
  if (receipt.projectId !== entry.projectId || receipt.commandId !== entry.commandId || !['accepted', 'pending', 'completed', 'rejected', 'uncertain'].includes(receipt.status)) throw fail('Invalid command receipt', 502);
  return receipt;
}

export async function startConsole({ stateDir, port = 0, host = '127.0.0.1', timeoutMs = 1500 }) {
  if (host !== '127.0.0.1' && host !== '::1') throw fail('Console must bind to loopback');
  if (!isAbsolute(stateDir || '')) throw fail('An absolute private state directory is required');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  let origin;
  const cookie = `factotum_session=${token}`;
  const privateRequest = async binding => checkHandshake(await requestProject(binding.socketPath, { path: '/v1/handshake', timeoutMs }), binding);
  async function reconcile() {
    const initial = readState(stateDir).journal.filter(entry => !['completed', 'rejected'].includes(entry.status));
    for (const entry of initial) {
      let update;
      try {
        await privateRequest(entry);
        const receipt = receiptValid(await requestProject(entry.socketPath, { path: `/v1/commands/${encodeURIComponent(entry.commandId)}`, timeoutMs }), entry);
        update = { status: receipt.status, receipt, checkedAt: new Date().toISOString() };
      } catch (error) {
        update = { status: 'unknown', detail: error.statusCode === 404 ? 'No canonical receipt; request was not resubmitted.' : error.message, checkedAt: new Date().toISOString() };
      }
      mutateState(stateDir, state => {
        const current = state.journal.find(item => item.projectId === entry.projectId && item.commandId === entry.commandId);
        if (!['completed', 'rejected'].includes(current.status)) Object.assign(current, update);
      });
    }
    return readState(stateDir).journal.map(publicEntry);
  }
  async function projects() {
    const bindings = readState(stateDir).bindings.filter(binding => binding.active);
    const results = [];
    for (let offset = 0; offset < bindings.length; offset += 8) {
      results.push(...await Promise.all(bindings.slice(offset, offset + 8).map(async binding => {
        try {
          await privateRequest(binding);
          const snapshot = await requestProject(binding.socketPath, { path: '/v1/snapshot', timeoutMs });
          if (snapshot.projectId !== binding.projectId) throw fail('Snapshot identity mismatch', 409);
          return { ...publicBinding(binding), status: 'available', observedAt: new Date().toISOString(), snapshot };
        } catch (error) { return { ...publicBinding(binding), status: error.message.includes('Incompatible') ? 'incompatible' : 'unavailable', error: error.message }; }
      })));
    }
    return results;
  }
  async function projectRead(url) {
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent);
    const [projectId, kind, subject] = parts;
    const bindingId = url.searchParams.get('bindingId');
    if (parts.length!==3 || !id(projectId) || !id(bindingId) || !subjectId(subject)) throw fail('Invalid project read route');
    const binding = readState(stateDir).bindings.find(b=>b.active && b.projectId===projectId && b.bindingId===bindingId);
    if (!binding) throw fail('Unknown or stale project binding',409);
    const query = new URLSearchParams(); let path, fields;
    if(kind==='tasks') { path=`/v1/tasks/${encodeURIComponent(subject)}`;fields=['projectId','task','queue','flows']; }
    else if(kind==='flows') { path=`/v1/flows/${encodeURIComponent(subject)}`;fields=['projectId','flow','attempts','inbox','events','waits','contexts','pushback','obligations','regressions','retrospective','capacity','learningCitations']; }
    else if(kind==='jobs') { path=`/v1/jobs/${encodeURIComponent(subject)}`;fields=['projectId','job']; }
    else if(kind==='collections' && collections.has(subject)) {
      const cursor=url.searchParams.get('cursor')||'0',limit=url.searchParams.get('limit')||'50',order=url.searchParams.get('order');
      if(!/^\d{1,9}$/.test(cursor)||!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(order!==null&&!['asc','desc'].includes(order))) throw fail('Invalid collection pagination');
      query.set('cursor',cursor);query.set('limit',limit);if(order)query.set('order',order);path=`/v1/collections/${subject}?${query}`;fields=['projectId','items','total','nextCursor'];
    } else if(kind==='stats' && ['7d','30d','12w'].includes(subject)) { path=`/v1/stats/${subject}`;fields=STATS_FIELDS;
    } else if(kind==='timeline' && ['6','12','24','72'].includes(subject)) { path=`/v1/timeline/${subject}`;fields=['projectId','window','pools','events','machine','stats'];
    } else if(kind==='previews') { const name=url.searchParams.get('name')??'';query.set('name',name);path=`/v1/previews/${encodeURIComponent(subject)}?${query}`;fields=['projectId','attemptId','name','dataUrl'];
    } else if(kind==='artifacts') {
      const name=url.searchParams.get('name');if(!artifactNames.has(name))throw fail('Unsupported artifact name');
      query.set('name',name);path=`/v1/artifacts/${encodeURIComponent(subject)}?${query}`;fields=['projectId','attemptId','name','text','truncated','available'];
    } else throw fail('Unsupported project read route',404);
    const allowed = kind==='collections'?['bindingId','cursor','limit','order','include']:['artifacts','previews'].includes(kind)?['bindingId','name']:['bindingId'];
    for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw fail('Unexpected project read parameter');
    await privateRequest(binding);
    const result=await requestProject(binding.socketPath,{path,timeoutMs});
    if(result.projectId!==projectId)throw fail('Project response identity mismatch',502);
    if(kind==='tasks' && result.task?.id!==subject)throw fail('Task response identity mismatch',502);
    if(kind==='flows' && result.flow?.id!==subject)throw fail('Flow response identity mismatch',502);
    if(kind==='jobs' && result.job?.id!==subject)throw fail('Job response identity mismatch',502);
    if(kind==='collections' && (!Array.isArray(result.items)||!Number.isSafeInteger(result.total)||result.total<0))throw fail('Invalid collection response',502);
    if(kind==='previews' && (result.attemptId!==subject||result.name!==url.searchParams.get('name')||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(result.dataUrl??'')))throw fail('Preview response identity mismatch',502);
    if(kind==='artifacts' && (result.attemptId!==subject||result.name!==url.searchParams.get('name')||typeof result.text!=='string'||typeof result.truncated!=='boolean'||(result.available!==undefined&&typeof result.available!=='boolean')))throw fail('Artifact response identity mismatch',502);
    if(!readState(stateDir).bindings.some(b=>b.active&&b.projectId===projectId&&b.bindingId===bindingId))throw fail('Project binding changed',409);
    return Object.fromEntries(fields.filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]]));
  }
  async function command(body) {
    const { projectId, bindingId, commandId, operation, payload, actor = 'operator', authority } = body;
    if (![projectId, bindingId, commandId].every(id) || !supported.includes(operation) || !payload || Array.isArray(payload) || typeof payload !== 'object' || !['operator', 'orchestrator'].includes(actor)) throw fail('Invalid command envelope');
    // A grant reference is part of the command: it is forwarded, journaled and digested, so the
    // same command id with a different reference is refused here as well as by the project.
    if (authority !== undefined && (!authority || typeof authority !== 'object' || Array.isArray(authority) || !Object.keys(authority).every(key => ['grantId', 'entryId', 'expectedVersion'].includes(key)) || !id(authority.grantId) || !id(authority.entryId) || !Number.isSafeInteger(authority.expectedVersion))) throw fail('Invalid authority reference');
    const state = readState(stateDir);
    const binding = state.bindings.find(item => item.active && item.projectId === projectId && item.bindingId === bindingId);
    if (!binding) throw fail('Unknown or stale project binding', 409);
    const digest = createHash('sha256').update(canonical({ operation, payload, actor, ...(authority ? { authority } : {}) })).digest('hex');
    const old = state.journal.find(entry => entry.projectId === projectId && entry.commandId === commandId);
    if (old) {
      if (old.digest !== digest || old.bindingId !== bindingId) throw fail('Command identity reused with different content or binding', 409);
      return publicEntry(old); // Recovery is a receipt lookup, never implicit dispatch.
    }
    await privateRequest(binding);
    // Reload after the handshake: concurrent registrations and commands must survive.
    const { entry, created } = mutateState(stateDir, latest => {
      if (!latest.bindings.some(item => item.active && item.projectId === projectId && item.bindingId === bindingId)) throw fail('Project binding changed', 409);
      const duplicate = latest.journal.find(item => item.projectId === projectId && item.commandId === commandId);
      if (duplicate) {
        if (duplicate.digest !== digest || duplicate.bindingId !== bindingId) throw fail('Command identity reused with different content or binding', 409);
        return { entry: duplicate, created: false };
      }
      const entry = { projectId, serviceId: binding.serviceId, bindingId, socketPath: binding.socketPath, commandId, operation, actor, ...(authority ? { authority } : {}), digest, submittedAt: new Date().toISOString(), status: 'unknown' };
      latest.journal.push(entry);
      return { entry, created: true };
    });
    if (!created) return publicEntry(entry);
    let update;
    try {
      const receipt = receiptValid(await requestProject(binding.socketPath, { method: 'POST', path: '/v1/commands', timeoutMs, body: { protocolVersion: 1, projectId, commandId, operation, payload, actor, ...(authority ? { authority } : {}) } }), entry);
      update = { status: receipt.status, receipt };
    } catch (error) { update = { status: 'unknown', detail: `${error.message}; query the canonical receipt before any retry.` }; }
    return mutateState(stateDir, after => {
      const persisted = after.journal.find(item => item.projectId === projectId && item.commandId === commandId);
      if (!['completed', 'rejected'].includes(persisted.status)) Object.assign(persisted, update);
      return publicEntry(persisted);
    });
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw fail('Invalid request origin', 403);
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/') {
        res.setHeader('set-cookie', `${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(readFileSync(resolve(assets, 'index.html'), 'utf8').replace('CSRF_TOKEN', token)); return;
      }
      if (req.method === 'GET' && path === '/favicon.svg') { res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'max-age=86400'); res.end(readFileSync(resolve(assets, 'favicon.svg'))); return; }
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && staticAssets.has(path)) {
        res.setHeader('content-type', path.endsWith('.mjs') ? 'text/javascript' : 'text/css');
        res.end(readFileSync(resolve(assets, staticAssets.get(path)))); return;
      }
      if (!req.headers.cookie?.split(';').map(value => value.trim()).includes(cookie)) throw fail('Console session required', 403);
      if (req.method === 'GET' && path.startsWith('/api/project/')) return json(200,await projectRead(url));
      if (req.method === 'GET' && path === '/api/projects') return json(200, await projects());
      if (req.method === 'GET' && path === '/api/journal') return json(200, readState(stateDir).journal.map(publicEntry));
      if (req.method !== 'POST' || req.headers['x-factotum-csrf'] !== token || req.headers['content-type'] !== 'application/json') throw fail('Invalid console request', 403);
      let text = '';
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 64 * 1024) throw fail('Request too large', 413); }
      let body;
      try { body = JSON.parse(text); } catch { throw fail('Invalid JSON'); }
      if (path === '/api/commands') return json(200, await command(body));
      if (path === '/api/reconcile') return json(200, await reconcile());
      throw fail('Not found', 404);
    } catch (error) {
      // A project's own refusal keeps its status (an artifact the attempt never wrote is 404, not a console fault).
      const status = error.status || ([400, 404, 409].includes(error.statusCode) ? error.statusCode : 500);
      json(status, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  return { server, url: origin, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), registerProject: config => registerProject(stateDir, config, { timeoutMs }), unregisterProject: projectId => unregisterProject(stateDir, projectId), reconcile };
}
