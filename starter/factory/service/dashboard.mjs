import { attemptEnvironmentView } from '../operations/attempt-environment-record.mjs';
import { recoveryHoldReason } from '../operations/recovery-hold.mjs';
import { notificationHealth } from '../operations/notifications.mjs';
import { isMaintenanceTask, needsApproval, queueRevision, scheduleView, scheduledRows } from '../core/project.mjs';
import { operatorPresence } from '../core/communication.mjs';
import { settingsView, upkeepHealthView } from '../operations/views.mjs';
import { orderedQueue } from '../operations/queue-order.mjs';
import { queueStatus } from '../operations/queue-status.mjs';
import { projectTargets } from '../operations/targets.mjs';
import { sourceSettings } from '../operations/source-config.mjs';
import { sourceCapabilities } from '../operations/source-adapter.mjs';
import { spendingSnapshot } from '../operations/spending.mjs';
import { authorityLedgerEnabled } from '../core/decision-authority.mjs';
import { orchestratorSessionView } from '../operations/orchestrator-session.mjs';
import { decisionViews } from '../core/decisions.mjs';
import { providerLimitView } from '../operations/provider-limits.mjs';
import { FINDING_CLOSED_STATUSES, attemptCostMicros, liveSql, projectTaskCount, recentFindingsSql, recentProjectTasks } from '../core/records.mjs';
import { isMergeQuestion, mergeQuestionContext } from '../operations/merge-context.mjs';

// Polling is an overview, not a history export. Only the fields existing consoles need are
// projected, and all open attention/ownership and the complete queued order remain visible.
//
// A projection is the same shape computed two ways: in SQLite, before large execution records
// enter JS, for a kind whose records are verified (core/records.mjs), and from the parsed
// record otherwise. SQL never reads a record of an unverified kind as JSON here.
const projection = names => ({
  sql: `json_object(${names.map(name => `'${name}',json(data -> '$.${name}')`).join(',')})`,
  js: record => Object.fromEntries(names.map(name => [name, record[name] === undefined ? null : record[name]])),
});
const whole = { sql: 'data', js: record => record };
const taskFields = projection(['id','title','revision','approvedRevision','approvalKind','status','closed','blocked','tracked','notBefore','workflow','labels','category']);
const flowFields = projection(['id','taskId','kind','state','step','createdAt','finishedAt','stoppedAt','stopReason','abandonedAt','attemptId','visits','replaces','replacedBy','workflowName','target','pool','stopRequested','slotWait','parkedAt']);
const jobFields = projection(['id','operation','status','scheduleId','createdAt','finishedAt','flowId','dispatchedFlowId','outcome','heldReasons','payload']);
const attemptFields = projection(['id','flowId','step','status','reason','classification','createdAt','dispatchedAt','settledAt','costMicros','reservedMicros']);
const occurrenceFields = projection(['id','scheduleId','at','commandId','manual']);
// A flow in the overview list: its fields, its task's title and its publication URL.
const flowListed = {
  sql: `json_set(${flowFields.sql},'$.taskSnapshot',json_object('title',json_extract(data,'$.taskSnapshot.title')),'$.results.publish',json_object('url',json_extract(data,'$.results.publish.url')))`,
  js: flow => ({ ...flowFields.js(flow), taskSnapshot: { title: flow.taskSnapshot?.title ?? null }, results: { publish: { url: flow.results?.publish?.url ?? null } } }),
};
// A flow looked up for a schedule's last run: its fields and the outcome of its run step.
const flowRun = flow => { const run = flow.results?.run; return { ...flowFields.js(flow), results: { run: run && typeof run === 'object' && !Array.isArray(run) ? { route: run.route ?? null, exitCode: run.exitCode ?? null, head: run.head ?? null, report: run.report == null ? null : String(run.report).slice(-4000) } : null } }; };
const projections = { task: taskFields, flow: flowFields, job: jobFields, occurrence: occurrenceFields };
// What the snapshot has always shown of each kind besides the most recent records, in SQL and in JS.
const OPEN = {
  flow: { sql: "COALESCE(json_extract(data,'$.state'),'') NOT IN ('completed','failed')", js: flow => !['completed', 'failed'].includes(flow.state ?? '') },
  attempt: { sql: "json_extract(data,'$.settledAt') IS NULL", js: attempt => attempt.settledAt == null },
  inbox: { sql: '1', js: item => item.status === 'open' },
  obligation: { sql: '1', js: row => !['passed', 'failed', 'deferred'].includes(row.status ?? '') },
  finding: { sql: '1', js: row => row.status === 'unapproved' },
};
// Several reads of one kind merged in insertion order, each record once. A read is complete SQL selecting rowid and data.
const merged = (store, reads) => {
  const found = new Map();
  for (const [sql, args = []] of reads) for (const row of store.db.prepare(sql).all(...args)) found.set(row.rowid, row.data);
  return [...found].sort((a, b) => a[0] - b[0]).map(([, data]) => JSON.parse(data));
};
// A kind's open records and its most recently inserted ones, in insertion order. For a verified
// kind each is read through its index and settled history beyond the recent few is never read.
const openAndRecent = (store, kind, shape = whole, limit = 20) => {
  if (store.verified(kind)) return merged(store, [
    [liveSql(store, kind, `rowid, ${shape.sql} AS data`, ` AND (${OPEN[kind].sql})`)],
    [`SELECT rowid, ${shape.sql} AS data FROM records ${store.hint('records_kind')} WHERE kind='${kind}' ORDER BY rowid DESC LIMIT ?`, [limit]],
  ]);
  const all = store.stored(kind), recent = new Set(all.slice(-limit));
  return all.filter(record => OPEN[kind].js(record) || recent.has(record)).map(shape.js);
};
// The findings Health acts on: every open one; the tasked ones, whose disposition controls stay
// while their to-do is pending, and the most recently closed ones, which a person may reopen, each
// by the time of their last change of status and bounded; and the most recently recorded, as
// before. Insertion order, each finding once.
export const HEALTH_TASKED_FINDINGS = 100, HEALTH_CLOSED_FINDINGS = 20;
const healthFindings = store => {
  if (store.verified('finding')) return merged(store, [
    [liveSql(store, 'finding', 'rowid, data')],
    [recentFindingsSql(store, 'tasked', 'rowid, data'), [HEALTH_TASKED_FINDINGS]],
    [recentFindingsSql(store, 'closed', 'rowid, data'), [HEALTH_CLOSED_FINDINGS]],
    [`SELECT rowid, data FROM records ${store.hint('records_kind')} WHERE kind='finding' ORDER BY rowid DESC LIMIT ?`, [20]],
  ]);
  const all = store.stored('finding'), latest = (rows, limit) => rows.map((row, index) => ({ row, index })).sort((a, b) => String(b.row.statusAt ?? '').localeCompare(String(a.row.statusAt ?? '')) || b.index - a.index).slice(0, limit).map(entry => entry.row);
  const keep = new Set([...all.filter(row => row.status === 'unapproved'), ...latest(all.filter(row => row.status === 'tasked'), HEALTH_TASKED_FINDINGS), ...latest(all.filter(row => FINDING_CLOSED_STATUSES.includes(row.status)), HEALTH_CLOSED_FINDINGS), ...all.slice(-20)]);
  return all.filter(row => keep.has(row));
};
const hint = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
// An open merge question carries what the operator decides with (operations/merge-context.mjs),
// read from its flow through the store; the flow list itself stays a small projection.
const withMergeContext = (store, item) => {
  if (item?.status !== 'open' || item.kind !== 'question' || item.standalone || !item.flowId) return item;
  const flow = hint(() => store.get('flow', item.flowId), null);
  return isMergeQuestion(item, flow) ? { ...item, mergeContext: hint(() => mergeQuestionContext(flow), null) } : item;
};

// What the overview leaves out, because nobody reads it there (dev.85, I5c). A resolved inbox item
// keeps what the Inbox's Resolved view shows (its context, answer, note, relay and the questions the
// flow went ahead on), without the fields only answering uses: planQuestion and buildQuestion (read
// for an open item, and in full through status --inbox and the item's own record). A queue entry that
// left the queue keeps when it was claimed and finished and how long admission took after it was
// ready (Queue's "Started from the queue"); its admission observations matter only while it waits.
const resolvedItem = item => { if (item?.status === 'open') return item; const { planQuestion, buildQuestion, ...rest } = item; return rest; };
const queueRow = row => {
  if (row?.status === 'queued') return row;
  const { eligibility, admissionTiming, ...rest } = row;
  return { ...rest, ...(admissionTiming && typeof admissionTiming === 'object' ? { admissionTiming: { readyToAdmissionMs: admissionTiming.readyToAdmissionMs ?? null } } : {}) };
};
export function dashboardSnapshot(store) {
  const project = store.meta('project'), config = store.meta('config', {});
  const cache = new Map(), cached = (key, read) => { if (!cache.has(key)) cache.set(key, read()); return cache.get(key); };
  // Existing settings/schedule helpers need metadata, not task briefs, provider
  // transcripts, command receipts or historical attempt inputs. This facade is
  // deliberately local to one read; canonical commands never use it. It answers the
  // Store's reads with projected records.
  const shape = kind => projections[kind] ?? whole;
  const view = {
    db: store.db, hint: index => store.hint(index), verified: kind => store.verified(kind),
    meta: (...args) => store.meta(...args),
    // A whole kind. The snapshot itself reads only schedules this way (bounded by configuration).
    all(kind) { return cached(`all:${kind}`, () => store.stored(kind).map(shape(kind).js)); },
    stored(kind) { return view.all(kind); },
    live(kind) { return cached(`live:${kind}`, () => store.verified(kind) ? store.db.prepare(`${liveSql(store,kind,`${shape(kind).sql} AS data`)} ORDER BY rowid`).all().map(row => JSON.parse(row.data)) : view.all(kind)); },
    by(kind, name, value) { return store.by(kind,name,value).map(shape(kind).js); },
    count: kind => store.count(kind),
    get(kind, id) { const record = store.get(kind,id); return record && (kind === 'flow' ? flowRun(record) : shape(kind).js(record)); },
    // One whole record by key, for a reader that needs fields the projection drops (queue status reads the open context task's marker and models).
    record(kind, id) { return store.get(kind, id); },
  };
  const tasks = recentProjectTasks(store, 100).map(taskFields.js), taskCount = projectTaskCount(store);
  // Queued and claimed entries, and those finished within the last day (read from two days back, filtered exactly below).
  const queue = store.verified('queue') ? merged(store,[[liveSql(store,'queue','rowid, data')],[`SELECT rowid, data FROM records ${store.hint('records_queue_claimed')} WHERE kind='queue' AND json_extract(data,'$.claimedAt')>=?`,[new Date(Date.now()-2*86400000).toISOString()]]]) : store.stored('queue');
  const advisoryTask = task => ({...task, approved:task.approvedRevision===task.revision, admissionReasons:['Open task detail for current admission eligibility.'], admissionObserved:false});
  // The queued project tasks, in task order.
  const taskRow = store.db.prepare("SELECT rowid, data FROM records WHERE kind='task' AND id=?");
  const queuedTasks = view.live('queue').filter(q => q.status === 'queued').map(q => taskRow.get(q.id)).filter(Boolean).sort((a, b) => a.rowid - b.rowid).map(row => taskFields.js(JSON.parse(row.data))).filter(task => !isMaintenanceTask(task));
  const flows = openAndRecent(store,'flow',flowListed), findings = healthFindings(store);
  // Who holds the flow slots (operations/capacity.mjs): each listed flow says whether it is parked on an answer.
  const status = hint(()=>queueStatus(view),null), parked = new Set((status?.capacity?.parked ?? []).map(row => row.flowId));
  const counts = { actual: attemptCostMicros(store), reserved: store.live('attempt').filter(a => a.settledAt == null).reduce((sum, a) => sum + (a.reservedMicros ?? 0), 0) };
  const source = sourceSettings(config), sync = store.meta('sourceSync',{});
  return {
    snapshotView:'dashboard-v1', projectId:project.projectId, name:project.name, revision:store.meta('revision',0), paused:store.meta('paused'), recoveryHold:store.meta('recoveryHold'), recoveryHoldReason:recoveryHoldReason(store),
    health:{operationsFault:store.meta('operationsFault',null)??null,notifications:notificationHealth(store),attemptEnvironment:attemptEnvironmentView(store)},
    spending:spendingSnapshot(config,project.projectId), operatorPresence:operatorPresence(store), orchestratorSession:hint(()=>orchestratorSessionView(store),null),
    sourceSync:{...sync,capabilities:hint(()=>config.mode==='delivery'?sourceCapabilities(config):null,null),type:source.type,enabled:config.mode==='delivery'&&source.enabled,configurationCurrent:sync.configDigest?sync.configDigest===store.meta('configDigest'):null},
    editPreconditions:{operatorPresenceVersion:true,taskRevision:true,scheduleGrant:true,queueOrder:true},
    commissioningRequired:config.mode==='delivery'&&!(store.meta('commissioning')?.ready&&store.meta('commissioning')?.configDigest===store.meta('configDigest')),
    tasks:tasks.map(advisoryTask), taskCount, maintenanceTaskCount:store.count('task')-taskCount, approvalNeededCount:view.live('task').filter(t=>!isMaintenanceTask(t)&&needsApproval(t)).length,
    flows:flows.map(f=>({...f,parked:parked.has(f.id),outcome:f.abandonedAt?'abandoned':f.state})),
    attempts:openAndRecent(store,'attempt',attemptFields),
    inbox:openAndRecent(store,'inbox').map(item=>withMergeContext(store,resolvedItem(item))),
    obligations:openAndRecent(store,'obligation'),
    findings,
    // Knowledge upkeep in Health: what is suspended, and the open candidates (bounded by their caps),
    // taken from the findings just read. Totals are in Stats.
    upkeep:hint(()=>upkeepHealthView(store,{findings}),null),
    events:store.events(15), budget:{unit:'USD_MICRO',...counts},
    queueComplete:true,queueRevision:queueRevision(view),queueTasks:queuedTasks.map(advisoryTask),queueDispatchOrder:orderedQueue(view).map(row=>row.id),queueStatus:status,
    queue:queue.filter(q=>['queued','claimed'].includes(q.status)||q.status==='finished'&&Date.parse(q.claimedAt)>=Date.now()-86400000).map(queueRow),
    schedules:view.all('schedule').map(s=>scheduleView(view,s)),scheduled:hint(()=>scheduledRows(view),[]),
    mainHealth:store.meta('mainHealth',{status:'unknown'}),targets:hint(()=>projectTargets(view),[]),targetHealth:store.meta('targetHealth',{}),
    settings:settingsView(view),providerLimits:hint(()=>providerLimitView(store),null),stats:{partial:true,flows:{total:store.count('flow')}},synthetic:config.mode!=='delivery',
    // Complete records remain available on demand. Omitted history is not empty history.
    detailEndpoints:{flows:'/v1/flows/:id',tasks:'/v1/tasks/:id',history:'/v1/collections/:kind',stats:'/v1/stats/:window'},
    // Migrated projects: open durable decisions (and recent settled ones), separate from inbox cards.
    ...(authorityLedgerEnabled(store)?{decisions:hint(()=>decisionViews(store),[])}:{}),
  };
}
