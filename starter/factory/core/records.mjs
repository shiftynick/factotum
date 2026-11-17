// Record layout and the targeted reads over it. This module imports nothing from the rest
// of the factory, so any module can use it without an import cycle.
//
// Everything lives in records(kind,id,data); nothing here changes the schema version. Two
// things keep the cost of a read independent of settled history:
//
// 1. An attempt's dispatch intent (the full action input, tens of kilobytes) is stored apart
//    from the attempt, as an INTENT_KIND record with the attempt's id (core/intent-text.mjs
//    gives its exact form). get/need and all('attempt') still return the complete attempt.
//    The targeted reads below (live, by, stored, recent) return attempts as stored, without
//    the intent; intent(id) loads one.
//
//    Which layout a database uses is a property of the database, not of the runtime: intents
//    are stored separately only while the LAYOUT_FENCE triggers are installed. An earlier
//    release reads the intent only inline, so it must never work on a database that holds
//    separate intents; the fence makes SQLite refuse every write from a connection that has
//    not registered LAYOUT_FUNCTION, which only a runtime that reads both layouts does.
//    Without the fence (a database an earlier release wrote, or one returned to that layout
//    by `layout inline`), this runtime writes attempts inline, exactly as that release does.
//    operations/state-layout.mjs installs the fence and moves the intents when the project
//    service starts, and takes both back.
//
//    One rule decides which intent an attempt has, wherever it is read: if the attempt's own
//    record has an intent member, the intent is JSON.parse(record).intent (the last member
//    of several, null included); only otherwise is it the separate record's. Every reader
//    takes the member from JSON.parse, never from SQLite's JSON functions, which read the
//    first of several. Under the fence the two cannot both exist for long (the next
//    migration pass moves the inline one out, replacing the separate record).
// 2. LIVE names, per kind, the records that are not yet settled history. Each has a partial
//    index, so live(kind) reads only those rows. A caller filters the result exactly as it
//    filtered all(kind); its filter must select only rows LIVE admits. REFERENCES names the
//    fields a kind can be looked up by, each with an index, for by(kind, field, value).
//
// Every index is limited to the kinds it serves, so a write to any other kind evaluates none
// of these expressions.
//
// SQLite's JSON functions and JSON.parse read the same value from a record only when no
// object in it has two members of one name (SQLite reads the first, JSON.parse the last).
// The factory is JavaScript, so JSON.parse is right. Every value read from a record's body
// by SQL here (index keys, predicates, projections) is therefore used only for a kind that
// is verified: operations/state-layout.mjs has checked that none of its records has such a
// member, and the layout fence has been in place since (so nothing but Store.put, which
// writes JSON.stringify output, and the migration, which keeps text it has checked, has
// written it). Verification is a record of its own, meta[VERIFIED_META], naming the verified
// kinds. It is written only in the transaction that checks a kind's records and creates its
// indexes, and it is deleted, and every index here dropped, in the transaction that installs
// the fence and in the one that lifts it (invalidateVerification). So neither an index nor a
// fence proves anything by existing: Store.verified(kind) requires the fence, the record
// naming the kind, and the kind's indexes. For a kind that is not verified, every read below
// parses the whole kind in JavaScript, as the release before these reads did. An index
// whose definition lists no kinds reads no JSON.
export const INTENT_KIND = 'attemptIntent';
// A rule or learning class seen in one flow and not yet raised (knowledge upkeep). It is the one
// upkeep kind SQL reads as JSON (its index key), so it is verified like any indexed kind.
export const UPKEEP_OBSERVED_KIND = 'upkeepObserved';
// Whether an attempt's own record has an intent member is decided the way JSON.parse decides it:
// any top-level member named intent, whatever its value, however its key is spelled, and the
// last of several. SQLite's JSON functions read the first of several, so none is used for
// this. INTENT_TEXT only narrows the rows to look at, by text: a record with such a member
// contains "intent" or, when the key is spelled with escapes, a \u escape. It can match
// records without the member; core/intent-text.mjs decides.
export const INTENT_TEXT = "(instr(data,'\"intent\"')>0 OR instr(data,char(92)||'u')>0)";
export const LAYOUT_FUNCTION = 'factotum_attempt_intent_layout', LAYOUT_VERSION = 2;
export const LAYOUT_FENCE = Object.freeze(['meta', 'records', 'events', 'commands'].flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action => {
  const name = `factotum_layout_fence_${table}_${action.toLowerCase()}`;
  return { name, sql: `CREATE TRIGGER ${name} BEFORE ${action} ON ${table} WHEN ${LAYOUT_FUNCTION}() < ${LAYOUT_VERSION} BEGIN SELECT RAISE(ABORT, 'this runtime cannot write a state database that stores attempt intents separately; run layout inline with a release that can'); END` };
})));
const fenceFound = db => new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'factotum\\_layout\\_fence\\_%' ESCAPE '\\'").all().map(row => [row.name, row.sql]));
export function layoutFenceIntact(db) { const found = fenceFound(db); return LAYOUT_FENCE.every(trigger => found.get(trigger.name) === trigger.sql); }
// Callers hold a transaction. Installing completes or repairs the fence; removing drops all of it.
export function installLayoutFence(db) { const found = fenceFound(db); for (const trigger of LAYOUT_FENCE) { if (found.get(trigger.name) === trigger.sql) continue; if (found.has(trigger.name)) db.exec(`DROP TRIGGER ${trigger.name}`); db.exec(trigger.sql); } }
export function removeLayoutFence(db) { for (const name of fenceFound(db).keys()) db.exec(`DROP TRIGGER ${name}`); }
export const field = name => `json_extract(data,'$.${name}')`, text = name => `COALESCE(${field(name)},'')`;
// True for every value JavaScript treats as absent: missing, null, '', 0 and false.
const unset = name => `${text(name)} IN ('',0)`;
export const LIVE = Object.freeze({
  // Unfinished flows, plus finished ones the operations loop still owes a repair or a cleanup retry.
  flow: `(${text('state')} NOT IN ('completed','failed') OR ${unset('finishedAt')} OR ${field('cleanupPending')} IS NOT NULL)`,
  attempt: `(${unset('settledAt')} OR ${text('status')} NOT IN ('passed','failed','aborted','not-dispatched'))`,
  // Project tasks (not maintenance runs) that are neither closed nor completed.
  task: `(substr(id,1,4)<>'job:' AND ${text('approvalKind')} NOT IN ('schedule','job') AND ${field('closed')} IS NOT 1 AND ${text('status')}<>'completed')`,
  inbox: `${text('status')}='open'`,
  job: `${text('status')} IN ('queued','running')`,
  queue: `${text('status')} IN ('queued','claimed')`,
  wait: unset('endedAt'),
  obligation: `${text('status')} NOT IN ('passed','failed','deferred')`,
  finding: `${text('status')}='unapproved'`,
  delivery: `${text('status')} IN ('pending','sending','accepted')`,
});
// Findings beyond the open set (knowledge-upkeep design 4.3, 4.4). Open upkeep candidates are a
// set of their own, bounded by upkeep's caps whatever the audit backlog; tasked findings and the
// closed ones a person may reopen are each ordered by the time of their last change of status.
export const FINDING_OPEN_UPKEEP = `${LIVE.finding} AND ${text('source')}='upkeep'`;
export const FINDING_TASKED = `${text('status')}='tasked'`;
export const FINDING_CLOSED_STATUSES = Object.freeze(['declined', 'expired', 'failed', 'resolved-elsewhere']);
export const FINDING_CLOSED = `${text('status')} IN (${FINDING_CLOSED_STATUSES.map(status => `'${status}'`).join(',')})`;
// Kinds whose records name the flow they belong to.
const FLOW_SCOPED = ['attempt', 'inbox', 'wait', 'context', 'pushback', 'obligation', 'regression'];
const FLOW_SCOPE = `kind IN (${FLOW_SCOPED.map(kind => `'${kind}'`).join(',')})`;
export const REFERENCES = Object.freeze({
  // The index covers several kinds; a read repeats its condition so that SQLite can use it.
  flowId: { index: 'records_flow_ref', kinds: FLOW_SCOPED, scope: FLOW_SCOPE },
  taskId: { index: 'records_flow_task', kinds: ['flow'] },
  inboxId: { index: 'records_delivery_inbox', kinds: ['delivery'] },
  operation: { index: 'records_job_operation', kinds: ['job'] },
});
export const STATE_INDEXES = Object.freeze([
  // (kind) alone is ordered by rowid within a kind: insertion-ordered reads and "most recent N" need no sort.
  { name: 'records_kind', sql: 'CREATE INDEX records_kind ON records(kind)' },
  ...Object.entries(LIVE).map(([kind, where]) => ({ name: `records_live_${kind}`, kinds: [kind], sql: `CREATE INDEX records_live_${kind} ON records(kind) WHERE kind='${kind}' AND ${where}` })),
  { name: 'records_flow_ref', kinds: FLOW_SCOPED, sql: `CREATE INDEX records_flow_ref ON records(kind, ${field('flowId')}) WHERE ${FLOW_SCOPE}` },
  { name: 'records_flow_task', kinds: ['flow'], sql: `CREATE INDEX records_flow_task ON records(kind, ${field('taskId')}) WHERE kind='flow'` },
  { name: 'records_delivery_inbox', kinds: ['delivery'], sql: `CREATE INDEX records_delivery_inbox ON records(kind, ${field('inboxId')}) WHERE kind='delivery'` },
  // Jobs by operation, and by schedule (a manual run has no schedule), each in creation-time order.
  { name: 'records_job_operation', kinds: ['job'], sql: `CREATE INDEX records_job_operation ON records(kind, ${field('operation')}, ${field('createdAt')}) WHERE kind='job'` },
  { name: 'records_job_schedule', kinds: ['job'], sql: `CREATE INDEX records_job_schedule ON records(kind, ${field('scheduleId')}, ${field('operation')}, ${field('createdAt')}) WHERE kind='job'` },
  { name: 'records_occurrence_schedule', kinds: ['occurrence'], sql: `CREATE INDEX records_occurrence_schedule ON records(kind, ${field('scheduleId')}, ${field('at')}) WHERE kind='occurrence'` },
  // Flows by finish time and inbox items by creation time, for views over a recent window.
  { name: 'records_flow_finished', kinds: ['flow'], sql: `CREATE INDEX records_flow_finished ON records(kind, ${field('finishedAt')}) WHERE kind='flow'` },
  { name: 'records_inbox_created', kinds: ['inbox'], sql: `CREATE INDEX records_inbox_created ON records(kind, ${field('createdAt')}) WHERE kind='inbox'` },
  // An inbox item's status and version without reading the item.
  { name: 'records_inbox_version', kinds: ['inbox'], sql: `CREATE INDEX records_inbox_version ON records(kind, id, ${field('status')}, ${field('version')}) WHERE kind='inbox'` },
  { name: 'records_queue_claimed', kinds: ['queue'], sql: `CREATE INDEX records_queue_claimed ON records(kind, ${field('claimedAt')}) WHERE kind='queue'` },
  // The operation each separate intent runs, so history views need not load the intents.
  { name: 'records_intent_operation', kinds: [INTENT_KIND], sql: `CREATE INDEX records_intent_operation ON records(kind, id, ${field('intent.action.operation')}) WHERE kind='${INTENT_KIND}'` },
  // Attempts whose text could hold an intent member, so finding those that do does not read every attempt.
  { name: 'records_inline_intent', sql: `CREATE INDEX records_inline_intent ON records(kind) WHERE kind='attempt' AND ${INTENT_TEXT}` },
  // Project tasks (not maintenance runs), for their count and the most recent page.
  { name: 'records_project_task', kinds: ['task'], sql: `CREATE INDEX records_project_task ON records(kind) WHERE kind='task' AND substr(id,1,4)<>'job:' AND ${text('approvalKind')} NOT IN ('schedule','job')` },
  // Only attempts that cost something: the budget total reads these index entries and no attempt.
  { name: 'records_attempt_cost', kinds: ['attempt'], sql: `CREATE INDEX records_attempt_cost ON records(kind, ${field('costMicros')}) WHERE kind='attempt' AND ${field('costMicros')}>0` },
  // Knowledge upkeep (operations/upkeep-records.mjs). Open project tasks (the live task set) by
  // lower-cased id, for the bounded look into the reserved upkeep: namespace. Ids are ASCII, so
  // SQLite's lower() is the reservation's own lower-casing (core/upkeep-namespace.mjs).
  { name: 'records_open_task_lower_id', kinds: ['task'], sql: `CREATE INDEX records_open_task_lower_id ON records(kind, lower(id)) WHERE kind='task' AND ${LIVE.task}` },
  // Open knowledge upkeep candidates, apart from open audit findings, and findings that are tasked
  // or closed, each by the time of their last change of status (operations/upkeep-candidates.mjs).
  { name: 'records_finding_open_upkeep', kinds: ['finding'], sql: `CREATE INDEX records_finding_open_upkeep ON records(kind) WHERE kind='finding' AND ${FINDING_OPEN_UPKEEP}` },
  { name: 'records_finding_tasked', kinds: ['finding'], sql: `CREATE INDEX records_finding_tasked ON records(kind, ${field('statusAt')}) WHERE kind='finding' AND ${FINDING_TASKED}` },
  { name: 'records_finding_closed', kinds: ['finding'], sql: `CREATE INDEX records_finding_closed ON records(kind, ${field('statusAt')}) WHERE kind='finding' AND ${FINDING_CLOSED}` },
  // Classes observed in one flow and not yet raised, by the time they were first observed, oldest first.
  { name: 'records_upkeep_observed_first', kinds: [UPKEEP_OBSERVED_KIND], sql: `CREATE INDEX records_upkeep_observed_first ON records(kind, ${field('firstObservedAt')}) WHERE kind='${UPKEEP_OBSERVED_KIND}'` },
]);
// The indexes that read a kind's records as JSON, by kind.
export const KIND_INDEXES = new Map(); for (const index of STATE_INDEXES) for (const kind of index.kinds ?? []) KIND_INDEXES.set(kind, [...(KIND_INDEXES.get(kind) ?? []), index.name]);
// The record of which kinds are verified: {at, kinds, duplicates}. See the note at the top.
export const VERIFIED_META = 'recordsVerified';
export const recordVerification = (db, record) => db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VERIFIED_META, JSON.stringify(record));
// Forget that any kind is verified and drop this release's indexes. Callers hold the
// transaction that installs or lifts the layout fence.
export function invalidateVerification(db) {
  db.prepare('DELETE FROM meta WHERE key=?').run(VERIFIED_META);
  const named = new Set(STATE_INDEXES.map(index => index.name));
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='records'").all()) if (named.has(row.name)) db.exec(`DROP INDEX ${row.name}`);
}
// Create the indexes a database lacks, and rebuild one whose definition differs from this
// release's; an index that reads one of the `unverified` kinds is not created, and dropped if
// it exists. Returns the names it (re)built. Callers hold a transaction.
export function ensureStateIndexes(db, { unverified = [] } = {}) {
  const found = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='records' AND name LIKE 'records\\_%' ESCAPE '\\'").all().map(row => [row.name, row.sql])), built = [];
  for (const index of STATE_INDEXES) {
    const wanted = !(index.kinds ?? []).some(kind => unverified.includes(kind));
    if (wanted && found.get(index.name) === index.sql) continue;
    if (found.has(index.name)) db.exec(`DROP INDEX ${index.name}`);
    if (wanted) { db.exec(index.sql); built.push(index.name); }
  }
  return built;
}
export const PROJECT_TASK = `kind='task' AND substr(id,1,4)<>'job:' AND ${text('approvalKind')} NOT IN ('schedule','job')`;
// A complete attempt as a value: the intent goes where the engine writes it, immediately before intentDigest.
export function withIntent(stored, intent) {
  const record = {}; let placed = false;
  for (const [key, value] of Object.entries(stored)) { if (key === 'intentDigest' && !placed) { record.intent = intent; placed = true; } record[key] = value; }
  if (!placed) record.intent = intent;
  return record;
}

// SQLite has no statistics for these tables and, with several partial indexes over one kind,
// does not reliably pick the one a read was written for. Each targeted read therefore names
// its index (INDEXED BY), which also makes a read that its index cannot answer fail loudly
// rather than scan. Store.hint gives the name only for an index that exists with this
// release's definition behind the layout fence.
const DEFINITIONS = new Map(STATE_INDEXES.map(index => [index.name, index.sql]));
export function presentIndexes(db) {
  return new Set(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='records'").all().filter(row => DEFINITIONS.get(row.name) === row.sql).map(row => row.name));
}
const use = (store, index) => store.hint(index);
// SQL for the two general targeted reads, shared by the Store and the dashboard's projected
// reads. Only for a verified kind.
export const liveSql = (store, kind, projection = 'data', and = '') => `SELECT ${projection} FROM records ${use(store, `records_live_${kind}`)} WHERE kind='${kind}' AND ${LIVE[kind]}${and}`;
// Open upkeep candidates (not open audit findings), in insertion order; and tasked or closed
// findings, the most recent change of status first, at most `limit`. Only for a verified kind.
export const openUpkeepCandidatesSql = (store, projection = 'data') => `SELECT ${projection} FROM records ${use(store, 'records_finding_open_upkeep')} WHERE kind='finding' AND ${FINDING_OPEN_UPKEEP} ORDER BY rowid`;
export const recentFindingsSql = (store, which, projection = 'data') => { const [index, where] = { tasked: ['records_finding_tasked', FINDING_TASKED], closed: ['records_finding_closed', FINDING_CLOSED] }[which]; return `SELECT ${projection} FROM records ${use(store, index)} WHERE kind='finding' AND ${where} ORDER BY ${field('statusAt')} DESC LIMIT ?`; };
export const bySql = (store, kind, name, projection = 'data') => { const reference = REFERENCES[name]; return `SELECT ${projection} FROM records ${use(store, reference.index)} WHERE kind='${kind}'${reference.scope ? ` AND ${reference.scope}` : ''} AND ${field(name)}=?`; };

// Reads that answer from index entries or a bounded number of rows when the kind is verified,
// and by parsing the whole kind (the expression each replaced) when it is not. Each takes a Store.
const rows = found => found.map(row => JSON.parse(row.data));
// The same rule as isMaintenanceTask in core/project.mjs, and as PROJECT_TASK in SQL.
const maintenanceTask = task => ['schedule', 'job'].includes(task?.approvalKind) || task?.id?.startsWith('job:');
const byTime = name => (a, b) => String(a[name]).localeCompare(String(b[name]));
export const projectTaskCount = store => store.verified('task')
  ? store.db.prepare(`SELECT count(*) AS count FROM records ${use(store, 'records_project_task')} WHERE ${PROJECT_TASK}`).get().count
  : store.stored('task').filter(task => !maintenanceTask(task)).length;
export const recentProjectTasks = (store, limit) => store.verified('task')
  ? rows(store.db.prepare(`SELECT data FROM records ${use(store, 'records_project_task')} WHERE ${PROJECT_TASK} ORDER BY rowid DESC LIMIT ?`).all(limit)).reverse()
  : store.stored('task').filter(task => !maintenanceTask(task)).slice(-limit);
// Total recorded attempt cost. Costs are never negative, so only attempts that cost something count.
export const attemptCostMicros = store => store.verified('attempt')
  ? store.db.prepare(`SELECT COALESCE(SUM(${field('costMicros')}),0) AS total FROM records ${use(store, 'records_attempt_cost')} WHERE kind='attempt' AND ${field('costMicros')}>0`).get().total
  : store.stored('attempt').reduce((sum, attempt) => sum + (attempt.costMicros ?? 0), 0);
// The newest record by a time field, with its rowid: one without a time if there is any (as
// text, "undefined" sorts after every timestamp), else the greatest time; among equals the
// later-inserted one (or the earlier-inserted with first:true).
const newest = (store, index, where, args, time, { first = false } = {}) => {
  const pick = (extra, order) => store.db.prepare(`SELECT rowid, data FROM records WHERE rowid=(SELECT rowid FROM records ${use(store, index)} WHERE ${where}${extra} ORDER BY ${order}rowid ${first ? 'ASC' : 'DESC'} LIMIT 1)`).get(...args);
  const row = pick(` AND ${field(time)} IS NULL`, '') ?? pick('', `${field(time)} DESC, `);
  return row ? { rowid: row.rowid, record: JSON.parse(row.data) } : null;
};
const JOB_OF_SCHEDULE = `kind='job' AND ${field('scheduleId')}=?`, MANUAL_JOB = `kind='job' AND ${field('scheduleId')} IS NULL AND ${field('operation')}=?`;
// How many jobs ran for a schedule, and the latest of them by creation time (the later-inserted
// one on equal times). A schedule that comes from configuration also counts manual runs (jobs
// with no schedule) of its operation.
export function scheduleRuns(store, schedule) {
  if (!store.verified('job')) {
    const jobs = store.stored('job').filter(job => job.scheduleId === schedule.id || schedule.source === 'config' && !job.scheduleId && job.operation === schedule.operation).sort(byTime('createdAt'));
    return { runs: jobs.length, last: jobs.at(-1) ?? null };
  }
  const count = (where, value) => store.db.prepare(`SELECT count(*) AS count FROM records ${use(store, 'records_job_schedule')} WHERE ${where}`).get(value).count;
  const manual = schedule.source === 'config' && typeof schedule.operation === 'string';
  const found = [newest(store, 'records_job_schedule', JOB_OF_SCHEDULE, [schedule.id], 'createdAt'), manual ? newest(store, 'records_job_schedule', MANUAL_JOB, [schedule.operation], 'createdAt') : null].filter(Boolean);
  const last = found.sort((a, b) => String(a.record.createdAt).localeCompare(String(b.record.createdAt)) || a.rowid - b.rowid).at(-1)?.record ?? null;
  return { runs: count(JOB_OF_SCHEDULE, schedule.id) + (manual ? count(MANUAL_JOB, schedule.operation) : 0), last };
}
// Flows that are live or finished at or after a time, and inbox items created at or after one, in
// insertion order. Times compare as the ISO strings the factory writes; callers pass a time
// earlier than they need and filter the result exactly (so every flow, or item, is a valid answer too).
export const flowsSince = (store, iso) => store.verified('flow')
  ? rows(store.db.prepare(`SELECT data FROM records WHERE rowid IN (${liveSql(store, 'flow', 'rowid')} UNION SELECT rowid FROM records ${use(store, 'records_flow_finished')} WHERE kind='flow' AND ${field('finishedAt')}>=?) ORDER BY rowid`).all(iso))
  : store.stored('flow');
export const inboxSince = (store, iso) => store.verified('inbox')
  ? rows(store.db.prepare(`SELECT data FROM records ${use(store, 'records_inbox_created')} WHERE kind='inbox' AND ${field('createdAt')}>=? ORDER BY rowid`).all(iso))
  : store.stored('inbox');
// The operation an attempt's separately stored intent runs, by attempt id: from the index when
// the intent records are verified, otherwise from each intent as it is asked for.
export function attemptOperations(store) {
  if (store.verified(INTENT_KIND)) { const found = new Map(store.db.prepare(`SELECT id, ${field('intent.action.operation')} AS operation FROM records ${use(store, 'records_intent_operation')} WHERE kind='${INTENT_KIND}'`).all().map(row => [row.id, row.operation ?? undefined])); return id => found.get(id); }
  const read = store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?'), found = new Map();
  return id => { if (!found.has(id)) { const row = read.get(INTENT_KIND, id); found.set(id, row ? JSON.parse(row.data).intent?.action?.operation : undefined); } return found.get(id); };
}
// The id and version of every inbox item in one of these statuses, in insertion order.
export const inboxVersions = (store, statuses) => store.verified('inbox')
  ? store.db.prepare(`SELECT id, ${field('version')} AS version FROM records ${use(store, 'records_inbox_version')} WHERE kind='inbox' AND ${text('status')} IN (${statuses.map(() => '?').join(',')}) ORDER BY rowid`).all(...statuses)
  : store.stored('inbox').filter(item => statuses.includes(item.status)).map(item => ({ id: item.id, version: item.version ?? null }));
export const lastOccurrence = (store, scheduleId) => store.verified('occurrence')
  ? newest(store, 'records_occurrence_schedule', `kind='occurrence' AND ${field('scheduleId')}=?`, [scheduleId], 'at')?.record ?? null
  : store.stored('occurrence').filter(occurrence => occurrence.scheduleId === scheduleId).sort(byTime('at')).at(-1) ?? null;
// The most recently created job of an operation (the earlier-inserted one on equal times).
export const latestJob = (store, operation) => store.verified('job')
  ? newest(store, 'records_job_operation', `kind='job' AND ${field('operation')}=?`, [operation], 'createdAt', { first: true })?.record ?? null
  : store.stored('job').filter(job => job.operation === operation).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
