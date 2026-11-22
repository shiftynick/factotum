import { projectTimeline } from '../operations/timeline-view.mjs';
import { projectStats } from '../operations/stats-view.mjs';
import { dashboardSnapshot } from './dashboard.mjs';
import http from 'node:http';
import net from 'node:net';
import { existsSync, lstatSync, unlinkSync, chmodSync, mkdirSync, openSync, closeSync, readSync, fstatSync, realpathSync, constants } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { Store } from '../core/store.mjs';
import { Engine } from '../core/engine.mjs';
import { executeCommand, handshake, taskView, publicFlow, publicAttempt } from '../core/project.mjs';
import { operationalTick } from '../workflows/maintenance.mjs';
import { assert, recordId, uid } from '../core/contracts.mjs';
import { captureConflictScope } from '../operations/conflicts.mjs';
import { flowCapacity } from '../operations/capacity.mjs';
import { learningCitationsOf } from '../operations/learnings.mjs';
import { authorityLedgerEnabled } from '../core/decision-authority.mjs';
import { decisionView } from '../core/decisions.mjs';
import { placeRecoveryHold, recordOperationsFault, clearOperationsFault } from '../operations/recovery-hold.mjs';
import { grantView } from '../core/grants.mjs';
import { migrateStateLayout } from '../operations/state-layout.mjs';
import { ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS, attemptEnvironmentCheckBoundMs } from '../operations/attempt-environment-probe.mjs';
import { beginAttemptEnvironmentRun, endAttemptEnvironmentRun, recordAttemptEnvironmentCheck } from '../operations/attempt-environment-record.mjs';

// environmentCheck: the attempt-environment check (dev.105, operations/attempt-environment-probe.mjs
// checkAttemptEnvironment), called as environmentCheck(store, { trigger, serviceRunId, timeoutMs,
// closing, signal }). The CLI's `serve` passes the real one; without it (tests, evaluations) no
// check runs and nothing is recorded. With it, the service records its run before its first tick
// (operations/attempt-environment-record.mjs), and while that run's start check is pending, new
// task flows and new maintenance that runs the project's tools are held, at most for the check's
// own bound (attemptEnvironmentCheckBoundMs). The check runs in the background once the socket is
// served, again when the configuration digest changes, one at a time; it never delays startup or a
// tick. Closing cancels it (its systemd-run client is stopped, its waits end, its unit is stopped
// by exact name with a short bounded call) and waits for it at most ENVIRONMENT_CHECK_CLOSE_WAIT_MS;
// a cancelled check records nothing.
const ENVIRONMENT_CHECK_CLOSE_WAIT_MS = 4000;
export async function startProjectService({ stateDir, socketPath, tickMs = 75, run = true, operationalIntervalMs = 1000, operationTick = operationalTick, environmentCheck = null, environmentCheckTimeoutMs = ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS }) {
  const store = new Store(stateDir), engine = new Engine(store);
  const socket = resolve(socketPath);
  assert(Buffer.byteLength(socket) <= 100, 'Unix socket path too long; choose a shorter private runtime path');
  const lock = net.createServer(c => c.destroy());
  try { await listen(lock, `\0factotum-runner-${store.meta('project').projectId}`); }
  catch (error) { store.close(); throw new Error(`project runner already owned or unavailable: ${error.code}`); }
  // This process now owns the project: bring a database written by an earlier release to the
  // current record layout before serving. A failure leaves the earlier layout in place, which
  // every read still understands; it is recorded and the service starts.
  try { migrateStateLayout(store); }
  catch (error) { try { store.tx(() => store.event('state.layout-migration-failed', { error: error.message })); } catch (recordError) { console.error(`state layout migration failed and could not be recorded: ${error.message}; ${recordError.message}`); } }
  let server;
  try {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    if (existsSync(socket)) {
      assert(lstatSync(socket).isSocket(), 'refusing to replace non-socket path');
      const live = await new Promise(resolve => {
        const connection = net.createConnection(socket);
        connection.once('connect', () => { connection.destroy(); resolve(true); });
        connection.once('error', () => resolve(false));
        connection.setTimeout(500, () => { connection.destroy(); resolve(true); });
      });
      assert(!live, 'project socket already in use'); unlinkSync(socket);
    }
    server = http.createServer(async (request, response) => {
      try {
        let result;
        const url = new URL(request.url, 'http://local'), path = url.pathname;
        if (request.method === 'GET' && path === '/v1/handshake') result = handshake(store);
        else if (request.method === 'GET' && path === '/v1/snapshot') result = dashboardSnapshot(store);
        else if (request.method === 'GET' && path.startsWith('/v1/collections/')) result = collection(store, path.slice('/v1/collections/'.length), url.searchParams);
        else if (request.method === 'GET' && path.startsWith('/v1/tasks/')) {
          const taskId=decodeURIComponent(path.slice('/v1/tasks/'.length));recordId(taskId,'task id');const task=store.get('task',taskId);if(!task)throw unavailable('unknown task');
          result={projectId:store.meta('project').projectId,task:taskView(store,task),flows:store.by('flow','taskId',taskId).map(publicFlow)};
        }
        else if (request.method === 'GET' && path.startsWith('/v1/flows/')) result = flowDetails(store, decodeURIComponent(path.slice('/v1/flows/'.length)));
        else if (request.method === 'GET' && path.startsWith('/v1/jobs/')) result = jobDetail(store, decodeURIComponent(path.slice('/v1/jobs/'.length)));
        else if (request.method === 'GET' && path.startsWith('/v1/stats/')) result = { projectId: store.meta('project').projectId, ...projectStats(store, { window: path.slice('/v1/stats/'.length) }) };
        else if (request.method === 'GET' && path.startsWith('/v1/timeline/')) result = { projectId: store.meta('project').projectId, ...projectTimeline(store, { hours: Number(path.slice('/v1/timeline/'.length)) }) };
        else if (request.method === 'GET' && path.startsWith('/v1/previews/')) result = previewImage(store, decodeURIComponent(path.slice('/v1/previews/'.length)), url.searchParams);
        else if (request.method === 'GET' && path.startsWith('/v1/artifacts/')) result = artifact(store, decodeURIComponent(path.slice('/v1/artifacts/'.length)), url.searchParams);
        else if (request.method === 'GET' && path === '/v1/commands') result = store.commandHistory();
        else if (request.method === 'GET' && path.startsWith('/v1/commands/')) {
          result = store.command(decodeURIComponent(path.slice('/v1/commands/'.length)));
          if (!result) return json(response, 404, { error: 'unknown command' });
        } else if (request.method === 'POST' && path === '/v1/commands') {
          result = executeCommand(store, await body(request));
        } else return json(response, 404, { error: 'unknown operation' });
        json(response, 200, publicValue(store, result));
      } catch (error) { json(response, error.status || 400, { error: publicValue(store, error.message) }); }
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    await listen(server, socket); chmodSync(socket, 0o600);
  } catch (error) { lock.close(); store.close(); throw error; }
  let pending = null, pendingOperations = null, closing = false;
  const tick = () => {
    if (pending || closing) return;
    pending = engine.tick().catch(error => {
      try { store.tx(() => { placeRecoveryHold(store, { cause: 'runner-fault', error: error.message }); store.event('runner.fault', { error: error.message }); }); }
      catch (recordError) { console.error(`runner fault could not be recorded: ${recordError.message}`); }
    }).finally(() => { pending = null; });
  };
  // The attempt-environment check: at start, and after the configuration changes (read once per
  // operations interval only when a check is configured).
  let environmentChecking = null, environmentCheckedConfig, environmentRun = null;
  const environmentAbort = new AbortController();
  if (run && environmentCheck) {
    const supervisor = store.meta('project').supervisor;
    try { environmentRun = beginAttemptEnvironmentRun(store, { id: uid(), supervisor, pendingUntil: new Date(Date.now() + attemptEnvironmentCheckBoundMs(environmentCheckTimeoutMs)).toISOString() }); }
    catch (error) { console.error(`attempt environment check run could not be recorded: ${error.message}`); }
  }
  const checkEnvironment = trigger => {
    if (!environmentCheck || !environmentRun || closing || environmentChecking) return;
    try { environmentCheckedConfig = store.meta('configDigest') ?? null; } catch { return; }
    const context = { trigger, serviceRunId: environmentRun.id, timeoutMs: environmentCheckTimeoutMs, closing: () => closing, signal: environmentAbort.signal };
    environmentChecking = new Promise(resolve => setImmediate(resolve)).then(() => closing ? null : environmentCheck(store, context))
      .catch(error => {
        if (closing) return;
        // A check that threw records unverified for this run, so its pending hold ends now.
        const message = String(error?.message ?? error).slice(0, 300);
        try { recordAttemptEnvironmentCheck(store, { status: 'unverified', reason: message, warnings: [`Could not check which node and git an attempt unit runs (${message})`], trigger, serviceRunId: environmentRun.id, checkedAt: new Date().toISOString(), supervisor: store.meta('project').supervisor, configDigest: store.meta('configDigest') ?? null }); }
        catch (recordError) { console.error(`attempt environment check failed and could not be recorded: ${message}; ${recordError.message}`); }
      })
      .finally(() => { environmentChecking = null; });
  };
  const operations = () => {
    if (environmentCheck && !closing && !environmentChecking) { try { if ((store.meta('configDigest') ?? null) !== environmentCheckedConfig) checkEnvironment('configuration'); } catch {} }
    if (closing || pendingOperations || store.meta('config', {}).mode !== 'delivery') return;
    // Only a fault that leaves state integrity in doubt places a recovery hold (operations/recovery-hold.mjs).
    pendingOperations = Promise.resolve().then(() => operationTick(store)).then(() => clearOperationsFault(store)).catch(error => {
      try { recordOperationsFault(store, error); } catch (recordError) { console.error(`operations fault could not be recorded: ${recordError.message}`); }
    }).finally(() => { pendingOperations = null; });
  };
  const timer = run ? setInterval(tick, tickMs) : null;
  const operationsTimer = run ? setInterval(operations, operationalIntervalMs) : null;
  if (run) { checkEnvironment('start'); tick(); operations(); }
  return { server, socketPath: socket, store, async close() {
    closing = true;
    if (timer) clearInterval(timer);
    if (operationsTimer) clearInterval(operationsTimer);
    environmentAbort.abort();
    await Promise.all([pending, pendingOperations].filter(Boolean));
    if (environmentChecking) await Promise.race([environmentChecking, new Promise(resolve => setTimeout(resolve, ENVIRONMENT_CHECK_CLOSE_WAIT_MS).unref())]);
    if (environmentRun) { try { endAttemptEnvironmentRun(store, environmentRun.id); } catch (error) { console.error(`attempt environment check run could not be closed: ${error.message}`); } }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (existsSync(socket)) unlinkSync(socket);
    await new Promise(resolve => lock.close(resolve));
    store.close();
  } };
}
function listen(server, address) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.off('error', reject); resolve(); }); }); }
function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); }
async function body(request) {
  let data = '', length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new Error('command too large'); data += chunk; }
  return JSON.parse(data);
}

const kinds = new Set(['grant','decision','task','flow','inbox','attempt','schedule','event','delivery','obligation','finding','pushback','regression','machineSample','wait','plan','retrospective','context','command','mainCheckObservation']);
const artifactNames = new Set(['stdout.log','stderr.log','action-result.json','provider/stdout.jsonl','provider/stderr.txt','provider/result.json','provider/output-schema.json','provider/prompt.txt']);
const unavailable = message => Object.assign(new Error(message), { status:404 });

/** Public projections exclude execution inputs and credentials, including nested action results. */
export function publicValue(store, value) {
  const privateKeys = /^(intent|modelRoutes|modelRoute|argv|env|environment|config|cwd|root|stateDir|artifactDir|socketPath|prompt|access_token|refresh_token|id_token|apiKey|api_key|authorization|password|secret|token|credentials|credential|cookie)$/i;
  const roots = [store.stateDir,store.meta('project')?.root].filter(Boolean).sort((a,b)=>b.length-a.length);
  const visit = item => {
    if(Array.isArray(item))return item.map(visit);
    if(item && typeof item==='object')return Object.fromEntries(Object.entries(item).filter(([key])=>!privateKeys.test(key)).map(([key,v])=>[key,visit(v)]));
    if(typeof item==='string') {
      let text=item;
      for(const root of roots)text=text.split(root).join('[private-project-path]');
      return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]').replace(/\b((?:OPENAI|ANTHROPIC|CODEX)_API_KEY|access_token|refresh_token|api_key|authorization|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[redacted]');
    }
    return item;
  };
  return visit(value);
}
function pagination(params) {
  for(const key of params.keys())assert(['cursor','limit','order','include'].includes(key)&&params.getAll(key).length===1,'unsupported collection parameter');
  assert(!params.has('include')||params.get('include')==='maintenance','include supports only maintenance');
  const cursor=params.get('cursor')??'0',limit=params.get('limit')??'50',order=params.get('order')??'asc';
  assert(/^\d{1,9}$/.test(cursor)&&/^\d{1,3}$/.test(limit)&&Number(limit)>0&&Number(limit)<=100&&['asc','desc'].includes(order),'invalid pagination');
  return {cursor:Number(cursor),limit:Number(limit),order};
}
export function collection(store,kind,params) {
  assert(kinds.has(kind),'unsupported collection');const {cursor,limit,order}=pagination(params);let items,total;
  // Events default to newest first for compatibility; other collections default to insertion order.
  const direction=order==='desc'?'DESC':'ASC';
  if(kind==='grant') {
    // Stored operator grants (migrated projects): exact entries, usage, validity and the uses made of them.
    assert(authorityLedgerEnabled(store),'the grant collection needs the migrated authority ledger');
    total=store.db.prepare("SELECT count(*) AS count FROM records WHERE kind='operatorGrant'").get().count;
    items=store.db.prepare(`SELECT data FROM records WHERE kind='operatorGrant' ORDER BY rowid ${direction} LIMIT ? OFFSET ?`).all(limit,cursor).map(row=>grantView(store,JSON.parse(row.data)));
  } else if(kind==='decision') {
    // Durable decisions (migrated projects), each with its holds, disposition history and cards.
    assert(authorityLedgerEnabled(store),'the decision collection needs the migrated authority ledger');
    total=store.db.prepare("SELECT count(*) AS count FROM records WHERE kind='decisionObligation'").get().count;
    items=store.db.prepare(`SELECT data FROM records WHERE kind='decisionObligation' ORDER BY rowid ${direction} LIMIT ? OFFSET ?`).all(limit,cursor).map(row=>decisionView(store,JSON.parse(row.data)));
  } else if(kind==='event') {
    total=store.db.prepare('SELECT count(*) AS count FROM events').get().count;
    items=store.db.prepare(`SELECT * FROM events ORDER BY sequence ${params.has('order')?direction:'DESC'} LIMIT ? OFFSET ?`).all(limit,cursor).map(e=>({...e,payload:JSON.parse(e.payload)}));
  } else if(kind==='command') {
    total=store.db.prepare('SELECT count(*) AS count FROM commands').get().count;
    items=store.db.prepare(`SELECT data FROM commands ORDER BY rowid ${direction} LIMIT ? OFFSET ?`).all(limit,cursor).map(row=>({id:JSON.parse(row.data).commandId,...JSON.parse(row.data)}));
  } else {
    // Maintenance runs carry synthetic task records; Tasks shows project work unless asked.
    const filter=kind==='task'&&params.get('include')!=='maintenance'?" AND COALESCE(json_extract(data,'$.approvalKind'),'') NOT IN ('schedule','job') AND id NOT LIKE 'job:%'":'';
    total=store.db.prepare(`SELECT count(*) AS count FROM records WHERE kind=?${filter}`).get(kind).count;
    items=store.db.prepare(`SELECT data FROM records WHERE kind=?${filter} ORDER BY rowid ${direction} LIMIT ? OFFSET ?`).all(kind,limit,cursor).map(row=>JSON.parse(row.data));
    if(kind==='task') { const conflictScope = store.meta('config', {}).mode === 'delivery' ? captureConflictScope(store) : undefined; items=items.map(task=>taskView(store,task,{conflictScope})); }if(kind==='flow')items=items.map(publicFlow);if(kind==='attempt')items=items.map(publicAttempt);
  }
  return {projectId:store.meta('project').projectId,items,total,nextCursor:cursor+items.length<total?cursor+items.length:null};
}
// One job's progress, for a console receipt that recorded a request (job.enqueue): a primary-key
// read projected to its lifecycle fields, never its payload or grant.
function jobDetail(store,jobId) {
  recordId(jobId,'job id');const job=store.get('job',jobId);if(!job)throw unavailable('unknown job');
  return {projectId:store.meta('project').projectId,job:Object.fromEntries(['id','operation','status','outcome','reason','held','flowId','dispatchedFlowId','createdAt','finishedAt'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]]))};
}
function flowDetails(store,flowId) {
  recordId(flowId,'flow id');const flow=store.get('flow',flowId);if(!flow)throw unavailable('unknown flow');
  const attempts=store.by('attempt','flowId',flowId),inbox=store.by('inbox','flowId',flowId);
  // Attempt lifecycle events carry only their attempt ID; include them so the timeline can place them.
  const attemptIds=JSON.stringify(attempts.map(a=>a.id));
  const events=store.db.prepare("SELECT * FROM events WHERE json_extract(payload,'$.flowId')=? OR json_extract(payload,'$.attemptId') IN (SELECT value FROM json_each(?)) ORDER BY sequence DESC LIMIT 400").all(flowId,attemptIds).map(e=>({...e,payload:JSON.parse(e.payload)}));
  const waits=store.by('wait','flowId',flowId),contexts=store.by('context','flowId',flowId);
  const pushback=store.by('pushback','flowId',flowId),obligations=store.by('obligation','flowId',flowId),regressions=store.by('regression','flowId',flowId);
  // Its place in the flow slots (operations/capacity.mjs), from the live flow set as queue status reads it.
  let capacity=null;try{capacity=flowCapacity(store,flow);}catch{/* shown as unknown rather than failing the read */}
  return {projectId:store.meta('project').projectId,flow:publicFlow(flow),attempts:attempts.map(attempt=>attemptDetail(store,attempt)),inbox,events,waits,contexts,pushback,obligations,regressions,retrospective:store.get('retrospective',flowId)??null,capacity,
    // What each role cited of the learnings the flow was shown (dev.92, P4), from the flow record.
    learningCitations:learningCitationsOf(flow)};
}
// A flow's attempt with the result of each check it ran (fast checks, gate checks): status, failure
// class and the bounded diagnostics the runner kept, so a failed check is readable in the attempt
// view without opening action-result.json. Only flow detail carries them; collections stay small.
// A main verification's own check rows, as its result recorded them (mainHealth.checks), for the
// attempt panel (dev.86, J4): each check's result and when it ran, the limit it ran under (a
// timed-out check's recorded limit, else its timeoutMs in the configuration this attempt ran with),
// the checks the step's time ran out for, and the step's own limit. Bounded; output stays in the check's evidence file.
const MAIN_CHECK_FIELDS=['id','tier','status','failureClass','timedOut','timeoutMs','limitSource','startedAt','endedAt','exitCode','attempts','flaked','reused'];
function mainVerification(health,mainChecks,stepTimeoutMs) {
  if(!health||typeof health!=='object'||!Array.isArray(health.checks))return null;
  const configured=id=>{const value=(Array.isArray(mainChecks)?mainChecks:[]).find(check=>check?.id===id)?.timeoutMs;return Number.isSafeInteger(value)?value:null;};
  const limited=(row,id)=>{const own=configured(id);return own===null?row:{...row,checkTimeoutMs:own};};
  const rows=health.checks.slice(0,32).filter(row=>row&&typeof row==='object').map(row=>limited(Object.fromEntries(MAIN_CHECK_FIELDS.filter(key=>row[key]!==undefined&&row[key]!==null&&typeof row[key]!=='object').map(key=>[key,row[key]])),row.id));
  const timeout=health.timeout&&typeof health.timeout==='object'?health.timeout:{};
  const notRun=(Array.isArray(timeout.notRun)?timeout.notRun:[]).slice(0,32).map(String).map(id=>limited({id},id));
  return {status:health.status,checks:rows,notRun,...(Number.isSafeInteger(timeout.stepTimeoutMs)?{stepTimeoutMs:timeout.stepTimeoutMs}:Number.isSafeInteger(stepTimeoutMs)?{stepTimeoutMs}:{})};
}
function attemptDetail(store,attempt) {
  // The evidence files this attempt actually has, so the console offers only those (a fast check has no provider logs).
  const base={...publicAttempt(attempt),artifacts:[...artifactNames].filter(name=>existsSync(join(store.stateDir,'attempts',attempt.id,name)))},checks=attempt.receipt?.actionResult?.checks;
  // Its intent (read by id, only for a main verification's attempt) holds the configuration it ran with.
  const health=attempt.receipt?.actionResult?.mainHealth,intent=Array.isArray(health?.checks)?attempt.intent??store.intent(attempt.id):null;
  const verified=mainVerification(health,intent?.action?.config?.mainChecks,intent?.timeoutMs),view=verified?{...base,mainVerification:verified}:base;
  if(!Array.isArray(checks))return view;
  return {...view,checks:checks.slice(0,16).filter(check=>check&&typeof check==='object').map(({id,status,failureClass,exitCode,prerequisite,diagnostics})=>({id,status,...(failureClass?{failureClass}:{}),...(Number.isInteger(exitCode)?{exitCode}:{}),...(prerequisite?{prerequisite:true}:{}),...(diagnostics&&typeof diagnostics==='object'?{diagnostics}:{})}))};
}
// A preview image, as a data URL for the merge question. Images only; HTML is never rendered.
const PREVIEW_TYPES={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
export function previewImage(store,attemptId,params) {
  recordId(attemptId,'attempt id');assert(store.get('attempt',attemptId),'unknown attempt');
  for(const key of params.keys())assert(key==='name'&&params.getAll(key).length===1,'unsupported preview parameter');
  const name=params.get('name')??'',type=PREVIEW_TYPES[name.split('.').pop().toLowerCase()];
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)&&type,'preview images are png, jpeg or webp files');
  const path=join(store.stateDir,'attempts',attemptId,'preview',name);
  if(!existsSync(path))throw unavailable('preview not available');
  assert(relative(realpathSync(store.stateDir),realpathSync(path))===join('attempts',attemptId,'preview',name),'preview link or ownership mismatch');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try { const stat=fstatSync(fd);assert(stat.isFile()&&stat.size<=5*1024*1024,'preview must be an ordinary file of at most 5 MB');const buffer=Buffer.alloc(stat.size);let offset=0;while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!n)break;offset+=n;}
    return {projectId:store.meta('project').projectId,attemptId,name,dataUrl:`data:${type};base64,${buffer.subarray(0,offset).toString('base64')}`}; }
  finally { closeSync(fd); }
}
function artifact(store,attemptId,params) {
  recordId(attemptId,'attempt id');assert(store.get('attempt',attemptId),'unknown attempt');
  for(const key of params.keys())assert(key==='name'&&params.getAll(key).length===1,'unsupported artifact parameter');
  const name=params.get('name');assert(artifactNames.has(name),'unsupported artifact name');
  const path=join(store.stateDir,'attempts',attemptId,name);
  // A file this attempt never wrote is an empty state, not an error: the attempt exists and simply has no such evidence.
  if(!existsSync(path))return {projectId:store.meta('project').projectId,attemptId,name,text:'',truncated:false,available:false};
  const realState=realpathSync(store.stateDir),real=realpathSync(path),rel=relative(realState,real);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'artifact escapes private state');
  const expected=join('attempts',attemptId,name);assert(rel===expected,'artifact link or ownership mismatch');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let text,truncated;
  try {
    const stat=fstatSync(fd);assert(stat.isFile(),'artifact must be an ordinary file');
    const limit=128*1024,buffer=Buffer.alloc(Math.min(limit,stat.size));let offset=0;
    while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!n)break;offset+=n;}
    text=buffer.subarray(0,offset).toString('utf8');truncated=stat.size>limit;
  } finally { closeSync(fd); }
  // Structured artifacts are projected before being rendered, never returned as executable HTML.
  if(name.endsWith('.json')) {
    if(truncated)text='Structured artifact exceeds the preview limit; inspect its complete private file with the CLI.';
    else { try { text=JSON.stringify(publicValue(store,JSON.parse(text)),null,2); } catch { text='Structured artifact is incomplete or malformed; inspect its private file with the CLI.'; } }
  } else if(name.endsWith('.jsonl')) {
    text=text.split('\n').filter(Boolean).map(line=>{try{return JSON.stringify(publicValue(store,JSON.parse(line)));}catch{return '[Incomplete structured trace line withheld]';}}).join('\n');
  }
  return {projectId:store.meta('project').projectId,attemptId,name,text:publicValue(store,text),truncated};
}
