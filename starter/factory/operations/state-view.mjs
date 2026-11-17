import { assert, recordId } from '../core/contracts.mjs';
import { publicAttempt, publicFlow, taskView } from '../core/project.mjs';
import { recoveryHoldReason } from './recovery-hold.mjs';
import { notificationHealth } from './notifications.mjs';
import { heldProviders } from './provider-limits.mjs';
import { queueStatus } from './queue-status.mjs';
import { spendingSnapshot } from './spending.mjs';
import { orchestratorSessionView } from './orchestrator-session.mjs';
import { operatorPresence } from '../core/communication.mjs';
import { upkeepRun } from './upkeep-records.mjs';
import { learningCitationsOf } from './learnings.mjs';

// `status --inbox/--flow/--task`: one item, its flow and its task with the project-wide holds
// needed to act on them, read by key. It never loads every attempt or flow: attempts come from
// the flow's own attempt events, open items from one inbox query. Its shape follows the starter
// state filter (project/integrations/factotum-state.example.jq), so a handling guide can use either.
const FAULT_EVENTS = ['operations.fault', 'runner.fault', 'operations.recovered', 'notification.paused', 'notification.resumed', 'restore.reconciled', 'provider.limit-held'];
const headOf = row => row?.identity?.head ?? row?.inputIdentity?.head ?? row?.head ?? row?.expectedHead ?? null;
function evidence(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  return { route: row.route ?? null, attemptId: row.attemptId ?? null, head: headOf(row),
    ...(row.result?.verdict ? { verdict: row.result.verdict, findings: (row.result.findings ?? []).map(f => ({ severity: f.severity, file: f.file, line: f.line, message: String(f.message ?? '').slice(0, 300) })) } : {}),
    ...(Array.isArray(row.checks) ? { checks: row.checks.map(c => ({ id: c.id, status: c.status })) } : {}),
    ...(row.merged != null ? { merged: row.merged, sha: row.sha ?? null } : {}),
    ...(row.released != null ? { released: row.released } : {}) };
}
// An attempt's operator-facing notice (core/engine.mjs attemptNotice, which this mirrors without importing the engine).
const noticeOf = attempt => { const notice = attempt?.receipt?.actionResult?.notice ?? attempt?.notice; return typeof notice === 'string' && notice ? notice : null; };
const pick = (value, keys) => value ? Object.fromEntries(keys.map(key => [key, value[key] ?? null])) : null;
const rows = (store, sql, ...args) => store.db.prepare(sql).all(...args);
// What a flow was shown and what it used (dev.92, P4), from the flow record read by key: the pin of
// its current plan cycle (learningSelection), earlier cycles' pins (learningHistory), what it counted
// as selected and cited (learningUse, without the delivery-window bookkeeping) and what each role
// cited (learningCitations). Null where the flow has none.
const pinView = row => row ? { cycle: row.cycle ?? null, step: row.step ?? null, commit: row.commit ?? null, dir: row.dir ?? null, at: row.at ?? null, entries: (row.entries ?? row.learnings ?? []).map(entry => ({ id: entry.id, path: entry.path ?? null, blob: entry.blob ?? null, ...(entry.flags?.length ? { flags: entry.flags } : {}) })), ...(row.skipped ? { skipped: row.skipped } : {}), ...(row.refused ? { refused: row.refused } : {}), ...(row.problem ? { problem: row.problem } : {}) } : null;
function learningsOfFlow(flow) {
  const use = flow.learningUse;
  return { learningSelection: pinView(flow.learningSelection), learningHistory: (flow.learningHistory ?? []).map(pinView),
    learningUse: use ? { selected: Array.isArray(use.selected) ? use.selected : [], cited: Array.isArray(use.cited) ? use.cited : [] } : null,
    learningCitations: learningCitationsOf(flow) };
}
const slotWait = (store, flow) => { try { return flow.slotWait ? queueStatus(store).capacity?.waiting.find(row => row.flowId === flow.id) ?? null : null; } catch { return null; } };

// The holds that stop the whole queue (queueStatus reads only unsettled dispatching attempts).
function queueHolds(store) {
  try { return (queueStatus(store).holds ?? []).map(hold => ({ kind: hold.kind, target: hold.target ?? null, ...(hold.taskId ? { taskId: hold.taskId } : {}), text: hold.text })); }
  catch (error) { return [{ kind: 'unavailable', target: null, text: `queue holds unavailable: ${error.message}` }]; }
}
function capacity(store) {
  try { const view = queueStatus(store).capacity; return view ? { maxParkedFlows: view.maxParkedFlows, parkedCount: view.parkedCount, waitingCount: view.waitingCount, pools: view.pools, categories: view.categories, parked: view.parked.map(row => ({ flowId: row.flowId, step: row.step, since: row.since, holdsSlot: row.holdsSlot })), waiting: view.waiting.map(row => ({ flowId: row.flowId, position: row.position, reason: row.reason })), categoryWaits: view.categoryWaits.map(row => ({ flowId: row.flowId, category: row.category, text: row.text })) } : null; }
  catch { return null; }
}
export function stateView(store, { inbox: inboxId, flow: flowId, task: taskId } = {}) {
  for (const [name, value] of Object.entries({ inbox: inboxId, flow: flowId, task: taskId })) if (value !== undefined) recordId(value, `${name} id`);
  assert(inboxId || flowId || taskId, 'name an inbox item, a flow or a task');
  const project = store.meta('project'), config = store.meta('config', {});
  const item = inboxId ? store.get('inbox', inboxId) ?? null : null;
  const f = flowId || item?.flowId || null, flow = f ? store.get('flow', f) ?? null : null;
  const t = taskId || flow?.taskId || item?.taskId || null, task = t ? store.get('task', t) ?? null : null;
  const spending = spendingSnapshot(config, project.projectId), main = store.meta('mainHealth', { status: 'unknown' }), session = orchestratorSessionView(store);
  const attemptIds = f ? rows(store, "SELECT json_extract(payload,'$.attemptId') AS id FROM events WHERE type='attempt.prepared' AND json_extract(payload,'$.flowId')=? ORDER BY sequence DESC LIMIT 5", f).map(row => row.id).reverse() : [];
  const shownFlow = flow ? publicFlow(flow) : null;
  // A failed flow's reason (dev.90, N1): the notice of its last failed attempt, as its failed notice
  // gave it (core/engine.mjs attemptNotice), read from the attempts already read above.
  const attemptRows = attemptIds.map(key => store.get('attempt', key)).filter(Boolean);
  const failedAttempt = attemptRows.filter(row => row.status === 'failed' || row.outcome === 'failed').at(-1);
  const failedNotice = noticeOf(failedAttempt);
  const failure = flow?.state === 'failed' && !flow.abandonedAt && failedNotice ? { step: failedAttempt.step, attemptId: failedAttempt.id, notice: failedNotice } : null;
  return {
    stateView: 'item-v1', projectId: project.projectId, revision: store.meta('revision', 0),
    project: {
      paused: store.meta('paused') ?? null, recoveryHold: store.meta('recoveryHold') ?? null, recoveryHoldReason: recoveryHoldReason(store),
      commissioningRequired: config.mode === 'delivery' && !(store.meta('commissioning')?.ready && store.meta('commissioning')?.configDigest === store.meta('configDigest')),
      holds: { paused: store.meta('paused') === true, recoveryHold: store.meta('recoveryHold') === true, moneyHold: store.meta('moneyHold', false) === true, retentionHold: Boolean(store.meta('retentionHold')), providerHolds: heldProviders(store) },
      queueHolds: queueHolds(store),
      // Flow slots: per pool the slots in use and free, flows parked on an answer and answered flows waiting for a slot.
      capacity: capacity(store),
      health: { operationsFault: store.meta('operationsFault', null) ?? null, notifications: notificationHealth(store) },
      spending: pick(spending, ['enabled', 'available', 'globalHold', 'actualMicros', 'heldMicros', 'reason']),
      mainHealth: { ...pick(main, ['status', 'head', 'checkedAt', 'tier']), scheduled: main.scheduled ? pick(main.scheduled, ['status', 'head', 'failed']) : null },
      operatorPresence: operatorPresence(store).state ?? null,
      session: pick(session, ['version', 'sessionId', 'deliveries', 'limit']),
    },
    recentFaults: rows(store, `SELECT sequence,at,type,payload FROM events WHERE type IN (${FAULT_EVENTS.map(() => '?').join(',')}) ORDER BY sequence DESC LIMIT 5`, ...FAULT_EVENTS).map(row => ({ ...row, payload: JSON.parse(row.payload) })),
    // The live set of inbox items is the open ones; it reads through SQL only for a verified kind.
    openItems: store.live('inbox').filter(item => item.status === 'open')
      .map(row => ({ id: row.id, kind: row.kind, role: row.role ?? null, title: row.title ?? null, question: row.question ?? null, flowId: row.flowId ?? null, version: row.version, presented: (row.presentations ?? []).some(p => p.status === 'pending') })),
    item,
    // A stop reason is shown only for a stopped flow: a flow resumed before dev.89 still carries its old one (dev.88 M8).
    flow: shownFlow ? { ...pick(shownFlow, ['id', 'taskId', 'kind', 'workflowName', 'state', 'outcome', 'step', 'stopReason', 'effectiveRisk', 'mergeDecisionRole', 'strictDecisionRole', 'attemptId', 'workspace', 'answerNotes', 'visitBudgets', 'parked', 'parkedAt', 'targetWait', 'mergeWait']), ...(shownFlow.state === 'stopped' ? {} : { stopReason: null }),
      // An answered flow waiting for a flow slot: why, and its place in line.
      slotWait: slotWait(store, flow),
      // Why a failed flow failed, when its step said (an enforcement refusal, a failed check); null otherwise.
      failure,
      ...learningsOfFlow(flow),
      evidence: Object.fromEntries(Object.entries(shownFlow.results ?? {}).map(([step, row]) => [step, evidence(row)])) } : null,
    attempts: attemptRows.map(row => ({ attempt: publicAttempt(row), notice: noticeOf(row) })).map(({ attempt: row, notice }) => ({ id: row.id, step: row.step, status: row.status, ...(row.outcome ? { outcome: row.outcome } : {}), settledAt: row.settledAt ?? null, ...(row.reason ? { reason: row.reason } : {}), ...(row.failure ? { failure: row.failure } : {}), ...(notice ? { notice } : {}) })),
    task: task ? pick(taskView(store, task), ['id', 'title', 'outcome', 'acceptance', 'revision', 'approved', 'approvedRevision', 'status', 'risk', 'paths', 'labels', 'models', 'notBefore', 'admissionReasons']) : null,
    queue: t ? store.get('queue', t) ?? null : null,
    // Knowledge upkeep's run for this flow (dev.88, L4): keyed by the merged flow's id, so read by
    // key; an upkeep assessment flow names its source flow in its job payload. Null when there is none.
    upkeepRun: f ? upkeepRun(store, f) ?? (flow?.jobPayload?.flowId ? upkeepRun(store, flow.jobPayload.flowId) ?? null : null) : null,
  };
}
