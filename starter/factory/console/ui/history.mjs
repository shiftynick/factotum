// Paginated canonical history with search, filters and drill-down. Filters apply to loaded pages.
import { h, chip, card, empty, notice, time, duration, between, short, button, segmented, table, usd, tag, flowName } from './dom.mjs';
import { api, available, readPath, uiState, saveUi, patchRoute, href } from './state.mjs';
import { recordDetail, eventLabel, eventDetail, attemptStatus, attemptChip } from './records.mjs';

const rerender = () => window.dispatchEvent(new Event('factotum:render'));
export const HISTORY_KINDS = {
  flow: { label: 'Flows', status: r => r.outcome ?? r.state, columns: [{ label: 'Flow', render: r => flowName(r) }, { label: 'State', render: r => chip(r.outcome ?? r.state) }, { label: 'Step', key: 'step' }, { label: 'Admitted', cls: 'nowrap', render: r => time(r.createdAt) }, { label: 'Elapsed', cls: 'nowrap', render: r => r.finishedAt ? duration(between(r.createdAt, r.finishedAt)) : 'open' }] },
  task: { label: 'Tasks', status: r => r.approvedRevision === r.revision ? 'approved' : r.status ?? 'unapproved', columns: [{ label: 'Task', render: r => r.title }, { label: 'ID', key: 'id' }, { label: 'Approval', render: r => chip(r.approvedRevision === r.revision ? 'approved' : 'unapproved', r.approvedRevision === r.revision ? 'Approved' : 'Unapproved') }, { label: 'Status', render: r => r.status ?? '—' }, { label: 'Criteria', render: r => String(r.acceptance?.length ?? 0) }, { label: 'Revision', render: r => short(r.revision, 10) }] },
  inbox: { label: 'Decisions', status: r => r.status, columns: [{ label: 'Question', render: r => r.question ?? r.id }, { label: 'Status', render: r => chip(r.status) }, { label: 'Role', key: 'role' }, { label: 'Answer', render: r => r.answer ?? '—' }, { label: 'Answered by', render: r => r.relay ? `${r.relay.relayedBy} (relayed from ${r.relay.channel})` : r.answeredBy ?? '—' }, { label: 'Flow', key: 'flowId' }, { label: 'Opened', render: r => time(r.createdAt) }] },
  attempt: { label: 'Attempts', status: attemptStatus, columns: [{ label: 'Attempt', render: r => short(r.id, 12) }, { label: 'Step', key: 'step' }, { label: 'Status', render: r => attemptChip(r) }, { label: 'Flow', key: 'flowId' }, { label: 'Prepared', render: r => time(r.createdAt) }, { label: 'Run time', render: r => duration(between(r.receipt?.startedAt, r.receipt?.endedAt)) }, { label: 'Cost', render: r => Number.isSafeInteger(r.costMicros) ? usd(r.costMicros) : 'unsettled' }] },
  event: { label: 'Events', status: r => r.type.split('.')[0], columns: [{ label: 'Event', render: r => eventLabel(r.type) }, { label: 'At', render: r => time(r.at) }, { label: 'Type', key: 'type' }, { label: 'Detail', render: r => eventDetail(r) || '—' }], id: r => String(r.sequence) },
  command: { label: 'Commands', status: r => r.status, columns: [{ label: 'Operation', render: r => r.operation }, { label: 'Status', render: r => chip(r.status) }, { label: 'Actor', key: 'actor' }, { label: 'Accepted', render: r => time(r.acceptedAt) }, { label: 'Error', render: r => r.error ?? '—' }] },
  wait: { label: 'Waits', status: r => r.endedAt ? r.reason ?? 'ended' : 'open', columns: [{ label: 'Wait', render: r => r.kind }, { label: 'Flow', key: 'flowId' }, { label: 'Started', render: r => time(r.startedAt) }, { label: 'Duration', render: r => r.endedAt ? duration(between(r.startedAt, r.endedAt)) : 'open' }, { label: 'Outcome', render: r => chip(r.endedAt ? r.reason ?? 'ended' : 'waiting', r.endedAt ? r.reason ?? 'ended' : 'open') }] },
  schedule: { label: 'Schedules', status: r => r.enabled ? 'enabled' : 'disabled', columns: [{ label: 'Schedule', key: 'id' }, { label: 'Operation', key: 'operation' }, { label: 'State', render: r => chip(r.enabled ? 'enabled' : 'disabled') }, { label: 'Trigger', render: r => r.type === 'interval' ? duration(r.everyMs) : `${r.timeOfDay ?? r.type} ${r.timezone ?? ''}` }] },
  delivery: { label: 'Notifications', status: r => r.status, columns: [{ label: 'Delivery', key: 'id' }, { label: 'Status', render: r => chip(r.status) }, { label: 'Channel', key: 'channel' }, { label: 'Inbox', key: 'inboxId' }, { label: 'Accepted', render: r => time(r.acceptedAt) }] },
  obligation: { label: 'Obligations', status: r => r.status, columns: [{ label: 'Obligation', render: r => r.title ?? r.id }, { label: 'Status', render: r => chip(r.status) }, { label: 'Owner', key: 'owner' }, { label: 'Flow', key: 'flowId' }, { label: 'Evidence', key: 'evidence' }] },
  finding: { label: 'Findings', status: r => r.status, columns: [{ label: 'Finding', render: r => r.title ?? r.message ?? r.id }, { label: 'Status', render: r => chip(r.status) }, { label: 'Source', key: 'source' }, { label: 'Evidence', key: 'evidence' }, { label: 'Observations', key: 'observations' }] },
  pushback: { label: 'Rule proposals', status: r => r.status, columns: [{ label: 'Rule', key: 'ruleId' }, { label: 'Proposal', key: 'reason' }, { label: 'Status', render: r => chip(r.status) }, { label: 'Actor', key: 'actor' }, { label: 'Flow', key: 'flowId' }] },
  regression: { label: 'Regressions', status: r => r.status, columns: [{ label: 'Report', key: 'reason' }, { label: 'Flow', key: 'flowId' }, { label: 'Status', render: r => chip(r.status) }, { label: 'Evidence', key: 'evidence' }, { label: 'Reported', render: r => time(r.observedAt) }] },
  mainCheckObservation: { label: 'Main check ledger', status: r => r.flaked ? 'flaked' : r.reused ? 'reused' : r.status, columns: [{ label: 'Check', key: 'checkId' }, { label: 'Status', render: r => chip(r.status) }, { label: 'Evidence', render: r => r.flaked ? 'Recovered registered flake' : r.reused ? 'Reused exact evidence' : 'Fresh execution' }, { label: 'Head', render: r => short(r.head,12) }, { label: 'Attempts', render: r => String(r.attempts?.length??0) }, { label: 'Verified', render: r => time(r.verifiedAt) }, { label: 'Recorded', render: r => time(r.observedAt) }] },
  context: { label: 'Context deliveries', status: () => 'recorded', columns: [{ label: 'Context', key: 'id' }, { label: 'Flow', key: 'flowId' }, { label: 'Digest', render: r => short(r.digest, 12) }, { label: 'Files', render: r => String(r.files?.length ?? 0) }, { label: 'Delivered', render: r => time(r.deliveredAt) }] },
  retrospective: { label: 'Retrospectives', status: r => r.state, columns: [{ label: 'Flow', render: r => r.taskTitle ? `${r.taskTitle} ${tag(r.flowId ?? r.id)}` : `Flow ${tag(r.flowId ?? r.id)}` }, { label: 'Outcome', render: r => chip(r.state) }, { label: 'Retry rounds', render: r => String(r.retryRounds ?? 0) }, { label: 'Gate passed', render: r => r.acceptance ? (r.acceptance.configuredGatePassed ? 'yes' : 'no') : '—' }, { label: 'Recorded', render: r => time(r.recordedAt) }] },
};
const pages = new Map();
const recordId = (kind, r) => (HISTORY_KINDS[kind].id ?? (x => String(x.id ?? x.commandId)))(r);

async function load(project, kind, order, size, { more = false } = {}) {
  const key = `${project.projectId}|${project.bindingId}|${kind}|${order}`;
  const page = pages.get(key) ?? { items: [], total: null, nextCursor: 0 };
  if (!more) Object.assign(page, { items: [], nextCursor: 0 });
  page.loading = true; page.error = null; pages.set(key, page); rerender();
  try {
    const result = await api(readPath(project, 'collections', kind, { cursor: String(page.nextCursor ?? 0), limit: String(size), order }));
    page.items.push(...result.items); page.total = result.total; page.nextCursor = result.nextCursor; page.fetchedAt = new Date().toISOString();
  } catch (error) { page.error = error.message; }
  finally { page.loading = false; rerender(); }
}

export function historyView(project, route) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'History is read from the project service and is unavailable until it responds.');
  const ui = uiState(`history:${project.projectId}`, { kind: 'flow', q: '', status: '', order: 'desc', size: 50 });
  if (route.params.kind && HISTORY_KINDS[route.params.kind] && route.params.kind !== ui.kind) { ui.kind = route.params.kind; ui.status = ''; saveUi(); }
  const kind = ui.kind, def = HISTORY_KINDS[kind];
  const key = `${project.projectId}|${project.bindingId}|${kind}|${ui.order}`;
  const page = pages.get(key);
  if (!page) { pages.set(key, { items: [], total: null, nextCursor: 0, loading: true }); queueMicrotask(() => load(project, kind, ui.order, ui.size)); }
  const items = page?.items ?? [];
  const statuses = [...new Set(items.map(def.status).filter(Boolean))].sort();
  const q = ui.q.trim().toLowerCase();
  const filtered = items.filter(r => (!ui.status || def.status(r) === ui.status) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
  const selected = route.params.record ? items.find(r => recordId(kind, r) === route.params.record) : null;
  const tabs = h('nav', { class: 'subtabs', 'aria-label': 'History collections' }, Object.entries(HISTORY_KINDS).map(([k, d]) => h('a', { href: href({ projectId: project.projectId, tab: 'history', params: { kind: k } }), class: k === kind ? 'active' : '', 'aria-current': k === kind ? 'page' : undefined, text: d.label })));
  const searchId = `history-q-${project.projectId}`;
  const controls = h('div', { class: 'toolbar filters' },
    h('div', { class: 'field inline' }, h('label', { for: searchId, text: 'Search loaded records' }), h('input', { id: searchId, type: 'search', value: ui.q, placeholder: 'ID, step, text…', dataset: { focusKey: 'history-search' }, on: { input: e => { ui.q = e.target.value; saveUi(); rerender(); } } })),
    h('div', { class: 'field inline' }, h('label', { for: `${searchId}-status`, text: 'Status' }), h('select', { id: `${searchId}-status`, dataset: { focusKey: 'history-status' }, on: { change: e => { ui.status = e.target.value; saveUi(); rerender(); } } }, h('option', { value: '', text: 'Any' }), statuses.map(s => h('option', { value: s, text: s, selected: s === ui.status })))),
    h('div', { class: 'field inline' }, h('label', { for: `${searchId}-order`, text: 'Order' }), h('select', { id: `${searchId}-order`, on: { change: e => { ui.order = e.target.value; saveUi(); rerender(); } } }, [['desc', 'Newest first'], ['asc', 'Oldest first']].map(([v, l]) => h('option', { value: v, text: l, selected: v === ui.order })))),
    h('div', { class: 'field inline' }, h('label', { for: `${searchId}-size`, text: 'Page size' }), h('select', { id: `${searchId}-size`, on: { change: e => { ui.size = Number(e.target.value); saveUi(); load(project, kind, ui.order, ui.size); } } }, [25, 50, 100].map(v => h('option', { value: String(v), text: String(v), selected: v === ui.size })))),
    button('Reload', () => load(project, kind, ui.order, ui.size), { variant: 'ghost' }));
  const status = h('p', { class: 'muted small', role: 'status' }, page?.loading ? 'Loading…' : page?.error ? '' : page ? `Showing ${filtered.length} of ${items.length} loaded · ${page.total ?? '?'} total${page.fetchedAt ? ` · read ${time(page.fetchedAt, { date: false })}` : ''}${(ui.q || ui.status) && page.nextCursor !== null ? ' · filters apply to loaded records; load more to search further' : ''}` : '');
  const body = page?.error ? notice('error', 'Could not read this collection.', page.error) : !page ? h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading…' }) : filtered.length ? table(def.columns, filtered, { onRow: r => kind === 'flow' || kind === 'retrospective' && (r.flowId ?? r.id) ? patchRoute({ flow: kind === 'flow' ? r.id : r.flowId ?? r.id, record: undefined }) : kind === 'task' ? patchRoute({ task: r.id, record: undefined }) : patchRoute({ record: recordId(kind, r) }), rowLabel: r => `Open ${def.label.toLowerCase().replace(/s$/, '')} ${recordId(kind, r)}`, selected: r => selected && recordId(kind, r) === recordId(kind, selected), caption: `${def.label} for ${project.name}` }) : empty(items.length ? 'No loaded records match' : `No ${def.label.toLowerCase()} recorded`);
  const more = page && page.nextCursor !== null && page.nextCursor !== undefined ? button(page.loading ? 'Loading…' : `Load ${ui.size} more`, () => load(project, kind, ui.order, ui.size, { more: true }), { disabled: page.loading }) : null;
  const detail = selected ? card(`${def.label.replace(/s$/, '')} ${short(recordId(kind, selected), 24)}`, recordDetail(kind === 'retrospective' ? 'retrospective' : kind, selected, project), { cls: 'detail-panel', actions: button('Close', () => patchRoute({ record: undefined }), { variant: 'ghost' }) }) : null;
  return h('div', { class: 'view' }, tabs, controls, status, h('div', { class: selected ? 'two-col wide-left' : '' }, h('div', { class: 'stack' }, body, more), detail));
}
