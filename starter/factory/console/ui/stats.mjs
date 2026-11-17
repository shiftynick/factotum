// Project statistics per period, read on demand. Each card has a headline over the window and a
// bar per period; a faded bar rests on too few samples to read as a trend. Click a bar for the flows.
import { h, card, kv, empty, notice, time, duration, relative, chip, table, segmented, button, link } from './dom.mjs';
import { state, available, href, read, readEntry, uiState, saveUi, detailHref } from './state.mjs';

const rerender = () => window.dispatchEvent(new Event('factotum:render'));
const WINDOWS = [['7d', 'By day, last 7 days'], ['30d', 'By day, last 30 days'], ['12w', 'By week, last 12 weeks']];
const COLORS = { builder: '--seg-building', reviewer: '--seg-review', planner: '--seg-planning', planning: '--seg-planning', building: '--seg-building', review: '--seg-review', checks: '--seg-checks', 'waiting-machine': '--seg-machine', 'waiting-operator': '--seg-operator', 'waiting-orchestrator': '--seg-orchestrator', other: '--seg-other' };
const PALETTE = ['--seg-building', '--seg-review', '--seg-checks', '--seg-planning', '--seg-orchestrator', '--seg-machine', '--seg-operator', '--seg-other'];
const compact = v => v === null || v === undefined ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
const fmt = (kind, v) => v === null || v === undefined ? '—' : kind === 'duration' ? duration(v) : ['usd', 'usd-total'].includes(kind) ? `$${v.toFixed(2)}` : kind === 'tokens' ? compact(v) : kind === 'percent' ? `${v}%` : kind === 'mean' ? (Math.round(v * 10) / 10).toFixed(1) : String(v);
// "1 document", not "1 documents": sample units are plural nouns.
export const unitFor = (n, unit) => n === 1 && typeof unit === 'string' ? unit.replace(/(?<!s)s$/, '') : unit;
const sample = m => ['count', 'usd-total', 'tokens'].includes(m.kind) ? `over the window, ${m.n} ${unitFor(m.n, m.sampleUnit)}` : m.kind === 'percent' ? `${m.hits} of ${m.n} ${unitFor(m.n, m.sampleUnit)}` : `${m.kind === 'duration' ? 'median ' : ''}from ${m.n} ${unitFor(m.n, m.sampleUnit)}`;

// A date label under every bar fits only up to seven bars: beyond that, at most seven labels are
// shown (the first, and evenly spaced after it), so twelve weekly labels never overflow a phone.
export const chartLabelShown = (count, i) => count <= 7 || i % Math.ceil(count / 6) === 0;
// Bars per period; stacked when the metric has parts. Clicking a bar selects that period.
function bars(m, { few, selected, onSelect, stack, colors }) {
  // A stacked period with no known part is unknown, not zero.
  const totals = m.buckets.map(b => { if (!stack) return b.value ?? null; const known = Object.values(b.parts ?? {}).filter(x => x !== null && x !== undefined); return m.kind === 'usd-total' && b.value !== undefined ? b.value : known.length ? known.reduce((a, c) => a + c, 0) : null; });
  const values = totals.map(v => v ?? 0), top = Math.max(1e-9, ...values);
  return h('div', { class: 'mchart' }, h('div', { class: 'mbars' }, m.buckets.map((b, i) => {
    const v = values[i], thin = !['count', 'usd-total', 'tokens'].includes(m.kind) && b.n < few, label = `${b.label}: ${fmt(stack && m.kind !== 'usd-total' ? 'duration' : m.kind, totals[i])}${b.unknown ? ` (unknown for ${b.unknown} step${b.unknown === 1 ? '' : 's'})` : ''}${m.kind === 'count' ? '' : ` from ${b.n}`}${thin ? ' (too few for a trend)' : ''}`;
    const fill = stack ? Object.entries(b.parts ?? {}).filter(([, x]) => x > 0).map(([k, x]) => h('span', { style: { flexGrow: String(x), background: `var(${colors[k]})` } })) : (v ? [h('span', { style: { flexGrow: '1' } })] : []);
    return h('button', { type: 'button', class: ['mbar', thin ? 'few' : '', selected === i ? 'selected' : ''], title: label, 'aria-label': label, 'aria-pressed': String(selected === i), disabled: !b.flowIds?.length, on: { click: () => onSelect(selected === i ? null : i) } },
      h('span', { class: 'mbar-fill', style: { height: `${v ? Math.max(3, v / top * 100) : 0}%` } }, fill));
  })), h('div', { class: 'mlabels' }, m.buckets.map((b, i) => h('span', { text: chartLabelShown(m.buckets.length, i) ? b.label : '' }))));
}
const flowList = (project, data, ids) => h('ul', { class: 'plain-list mflows' }, ids.map(id => { const f = data.flows[id]; return h('li', {}, link(detailHref({ projectId: project.projectId, flow: id }), f?.title ?? id), f ? h('span', { class: 'muted small', text: ` · ${f.pool} · ${f.state}` }) : null); }));

function metricCard(project, data, m, ui, { wide } = {}) {
  const key = m.id, selected = ui.selected?.[key] ?? null, stack = Boolean(m.legend);
  const onSelect = i => { ui.selected = { ...(ui.selected ?? {}), [key]: i }; saveUi(); rerender(); };
  return h('section', { class: ['card', 'metric', wide ? 'span-2' : ''] },
    h('h3', { class: 'card-title', text: m.title }),
    h('p', { class: 'metric-head' }, h('strong', { text: fmt(m.kind, m.headline) }), ' ', h('span', { class: 'muted small', text: m.n || m.kind === 'count' ? sample(m) : 'no samples in this window' })),
    bars(m, { few: data.few, selected, onSelect, stack, colors: COLORS }),
    stack ? h('ul', { class: 'legend' }, m.legend.map(([k, l, v, unknown]) => h('li', {}, h('span', { class: 'swatch', style: { background: `var(${COLORS[k]})` } }), `${l} ${m.kind === 'usd-total' ? fmt('usd', v) : duration(v)}${unknown ? ` (unknown for ${unknown} step${unknown === 1 ? '' : 's'})` : ''}`))) : null,
    m.note ? h('p', { class: 'help', text: m.note }) : null,
    selected !== null && m.buckets[selected] ? h('div', { class: 'stack' }, h('p', { class: 'small', text: `${m.buckets[selected].label}: ${m.buckets[selected].flowIds.length} flow(s)` }), flowList(project, data, m.buckets[selected].flowIds)) : null);
}
// Provider usage limits as last reported, and any hold on new work (readiness G7).
export function providerLimitsSection(view) {
  const p = view.policy, rows = view.providers.flatMap(row => row.windows.length ? row.windows.map(w => ({ row, w })) : [{ row, w: null }]);
  const intro = `Notice at ${p.noticePercent}% of a usage window; new work that would start a provider waits from ${p.holdPercent}% or when it reports its limit reached, until the reset (${duration(p.defaultHoldMs)} when no reset time is reported). Running work is never interrupted.`;
  const holds = view.providers.filter(row => row.held).map(row => notice('warning', `${row.provider} held until ${time(row.hold.until)}.`, `${row.hold.reason}. Clear or extend it with provider.hold.`));
  return section('Provider limits', h('div', { class: 'stack' }, ...holds, rows.length ? card('', table([
    { label: 'Provider', render: r => h('span', {}, h('strong', { text: r.row.provider }), r.row.plan ? h('span', { class: 'muted small', text: ` · ${r.row.plan}` }) : null) },
    { label: 'Window', render: r => r.w?.window ?? '—' },
    { label: 'Used', render: r => r.w?.percent === null || !r.w ? 'not reported' : `${r.w.percent}%` },
    { label: 'Status', render: r => r.w ? chip(r.w.reset ? 'none' : r.w.status === 'exhausted' ? 'error' : r.w.status === 'warning' ? 'hold' : 'idle', r.w.reset ? 'reset since' : r.w.status === 'exhausted' ? 'limit reached' : r.w.status) : '—' },
    { label: 'Resets', render: r => r.w?.resetsAt ? time(r.w.resetsAt) : 'not reported' },
    { label: 'Reported', render: r => r.w?.observedAt ? relative(r.w.observedAt) : '—' },
    { label: 'Hold', render: r => r.row.held ? chip('held', `held until ${time(r.row.hold.until)}`) : 'none' },
  ], rows)) : empty('No usage limits reported yet', 'Providers report usage with their model steps; nothing is assumed before then.')), intro);
}
const section = (title, body, intro) => h('section', { class: 'stats-section' }, h('h2', { class: 'section-title', text: title }), intro ? h('p', { class: 'help', text: intro }) : null, body);
const grid = (...cards) => h('div', { class: 'metric-grid' }, cards.filter(Boolean));

// The estimate per period stacked by model.
function byModelCard(byModel) {
  if (!byModel?.names.length) return null;
  const colors = Object.fromEntries(byModel.names.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
  const m = { id: 'cost-model', kind: 'usd-total', buckets: byModel.buckets.map(b => ({ ...b, n: 1, flowIds: [] })) };
  return h('section', { class: 'card metric span-2' }, h('h3', { class: 'card-title', text: 'List-price estimate per period, by model' }), bars(m, { few: 0, selected: null, onSelect: () => {}, stack: true, colors }),
    h('ul', { class: 'legend' }, byModel.names.map(n => h('li', {}, h('span', { class: 'swatch', style: { background: `var(${colors[n]})` } }), `${n} ${fmt('usd', byModel.buckets.reduce((s, b) => s + (b.parts[n] ?? 0), 0))}`))));
}
function checksSection(project, data, ui) {
  const c = data.checks;
  return section('Checks', h('div', { class: 'stack' }, grid(...c.metrics.map(m => metricCard(project, data, m, ui))),
    grid(card('Slowest checks', c.rows.length ? table([{ label: 'Check', render: r => r.id }, { label: 'Median', render: r => duration(r.medianMs) }, { label: 'Runs', render: r => String(r.runs) }, { label: 'Failed', render: r => String(r.failed) }], c.rows, { caption: 'Gate checks in this window' }) : empty('No gate runs in this window')),
      card('Main verification', c.main.length ? table([{ label: 'Ended', render: r => link(detailHref({ projectId: project.projectId, flow: r.flowId }), time(r.at, { seconds: false })) }, { label: 'Main at', render: r => r.head ? h('code', { text: r.head.slice(0, 12) }) : '—' }, { label: 'Tiers', render: r => r.tiers ? (r.tiers.includes('scheduled') ? 'Full (merge + scheduled)' : r.tier === 'merge' ? 'Merge tier' : 'Full') : '—' }, { label: 'Result', render: r => r.targetStatus && r.targetStatus !== r.status ? h('span', {}, chip(r.status), ` target ${r.targetStatus}`) : chip(r.status) }, { label: 'Failed checks', render: r => r.failedChecks.join(', ') || '—' }, { label: 'Merges since last green', render: r => String(r.mergesSinceGreen) }], c.main, { caption: 'Main verifications in this window' }) : empty('No main verifications in this window'), { cls: 'span-2' }))));
}

export function accountingRows(accounting) {
  return [['Completed-flow cohort', accounting.completionCohort], ['Invocation-start window', accounting.attemptWindow]].map(([scope, r]) => ({
    scope, coverage: `${r.measured} measured / ${r.invocations} invocations; ${r.missing} unknown; ${r.duplicateObservations} duplicates excluded`,
    input: compact(r.inputTokens), total: compact(r.totalTokens),
    actual: r.actualMicros === null ? `unavailable (${r.actualUnknown} unknown)` : `$${(r.actualMicros / 1e6).toFixed(6)} known; ${r.actualUnknown} unknown`,
  }));
}
function accountingCard(accounting) {
  return card('Accounting coverage', table([
    { label: 'Population', render: r => r.scope }, { label: 'Coverage', render: r => r.coverage },
    { label: 'Input-only tokens', render: r => r.input }, { label: 'Total tokens', render: r => r.total },
    { label: 'Known actual spend', render: r => r.actual },
  ], accountingRows(accounting), { caption: 'Accounting v1 · UTC [from, to) · account credit cost unavailable' }));
}

// The current orchestrator session's delivery count against its handoff limit.
export function orchestratorSessionSection(session) {
  if (!session) return null;
  const handoff = session.handoff;
  return section('Orchestrator session', card('', kv([
    ['Session', session.declared ? `${session.sessionId} · bound ${relative(session.boundAt)} by ${session.boundBy}` : 'Not declared; bind one with orchestrator.session'],
    ['Deliveries', session.limit ? `${session.deliveries} of ${session.limit}` : `${session.deliveries} (no handoff limit)`],
    ['Last delivery', session.lastDeliveryAt ? relative(session.lastDeliveryAt) : '—'],
    ['Handoff question', handoff ? `${handoff.status ?? 'missing'}${handoff.answer ? ` · answered “${handoff.answer}”` : ''} · raised at ${handoff.raisedAtDeliveries}${session.nextHandoffAt ? ` · next at ${session.nextHandoffAt}` : ''}` : session.limit ? `asked at ${session.limit}` : 'off'],
    ['Resets in 24 hours', `${session.resets?.last24h ?? 0}${session.resets?.lastNoticeAt ? ` · operator notified ${relative(session.resets.lastNoticeAt)}` : ''}`],
    ...(session.resets?.recent ?? []).map(reset => [`Reset ${relative(reset.at)}`, `${reset.fromSessionId ?? 'undeclared'} → ${reset.toSessionId} by ${reset.actor} · ended at ${reset.deliveries} deliveries${reset.lateAcceptances ? ` (${reset.lateAcceptances} accepted after the reset)` : ''}`]),
  ])), 'Deliveries the notification endpoint accepted for the current session. Binding a new session starts a new count; each reset is recorded with the count it ended.');
}
export function projectStats(project) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'Statistics are unknown while the project is unreachable; they are not shown as zero.');
  const ui = uiState(`stats:${project.projectId}`, { window: '7d' });
  if (!WINDOWS.some(([k]) => k === ui.window)) ui.window = '7d';
  let entry = readEntry(project, 'stats', ui.window);
  if (!entry || (entry.status === 'ready' && entry.revision !== project.snapshot.revision)) { entry = read(project, 'stats', ui.window, {}, { force: Boolean(entry), onDone: rerender }); entry.revision = project.snapshot.revision; }
  const head = h('div', { class: 'toolbar' }, segmented(WINDOWS, ui.window, v => { ui.window = v; ui.selected = {}; saveUi(); rerender(); }, 'Window'), button('Refresh', () => { read(project, 'stats', ui.window, {}, { force: true, onDone: rerender }); rerender(); }, { variant: 'ghost' }));
  const data = entry.data;
  if (!data) return h('div', { class: 'view stack' }, head, entry.status === 'error' ? notice('error', 'Statistics unavailable.', entry.error) : h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading…' }));
  const card_ = m => metricCard(project, data, m, ui), find = (list, id) => list.find(m => m.id === id);
  const b = data.backlog, open = b.openNow;
  const areaCard = b.areas ? (() => { const colors = Object.fromEntries(b.areas.names.map((n, i) => [n, PALETTE[i % PALETTE.length]])); const m = { id: 'areas', buckets: b.areas.buckets.map(x => ({ ...x, n: Object.values(x.parts).reduce((a, c) => a + c, 0), flowIds: [] })), kind: 'count' };
    return h('section', { class: 'card metric' }, h('h3', { class: 'card-title', text: 'Merges by area' }), bars(m, { few: 0, selected: null, onSelect: () => {}, stack: true, colors }), h('ul', { class: 'legend' }, b.areas.names.map(n => h('li', {}, h('span', { class: 'swatch', style: { background: `var(${colors[n]})` } }), n))), h('p', { class: 'help', text: 'Merged changes and documents by their task’s area, or category when there is no area.' })); })() : null;
  return h('div', { class: 'view stack stats' }, head,
    h('p', { class: 'help', text: `Work counts in the period it ended: merged, completed or failed; a stop counts when it happened. Faded bars rest on fewer than ${data.few} samples. Click a bar for the flows behind it. Computed ${relative(data.observedAt)}.` }),
    data.synthetic ? notice('info', 'Rehearsal data.', 'This project runs synthetic rehearsal workflows; outcomes are not delivery evidence.') : null,
    section('Throughput and speed', grid(card_(find(data.throughput, 'merged')), card_(find(data.throughput, 'documents')), card_(find(data.throughput, 'tasks')), card_(find(data.throughput, 'failed')), metricCard(project, data, find(data.throughput, 'duration'), ui, { wide: true }), card_(find(data.throughput, 'queue')))),
    section('Quality of first attempts', grid(...data.quality.map(card_)), 'Merged changes and documents, unless a card says otherwise.'),
    data.estimate ? section('List-price estimate', h('div', { class: 'stack' }, grid(metricCard(project, data, data.estimate.perChange, ui), metricCard(project, data, data.estimate.perPeriod, ui, { wide: true }), metricCard(project, data, data.estimate.tokens, ui), data.estimate.inputTokens ? metricCard(project, data, data.estimate.inputTokens, ui) : null, byModelCard(data.estimate.byModel)),
      data.estimate.unknownSteps ? notice('info', `${data.estimate.unknownSteps} of ${data.estimate.steps} model invocations have no attributable estimate.`, h('span', {}, 'Estimates need qualified usage and cost observations, or a configured model price in ', link(href({ projectId: project.projectId, tab: 'settings', params: { section: 'policy' } }), 'Settings → Policy → Statistics'), '.')) : null),
      'List-price estimates are comparison figures, not bills. Account-level credit cost is unavailable; subscription access does not establish zero spend. These cards include all invocations of flows completed or failed in this window, even when an invocation ran earlier.') : null,
    data.accounting ? accountingCard(data.accounting) : null,
    orchestratorSessionSection(project.snapshot.orchestratorSession),
    checksSection(project, data, ui),
    data.providerLimits ? providerLimitsSection(data.providerLimits) : null,
    section('Decisions', grid(...data.decisions.map(card_))),
    section('Failures and stops', data.failures.length ? card('', table([{ label: 'When', render: r => time(r.at, { seconds: false }) }, { label: 'Flow', render: r => link(detailHref({ projectId: project.projectId, flow: r.flowId }), data.flows[r.flowId]?.title ?? r.flowId) }, { label: 'Kind', render: r => data.flows[r.flowId]?.pool ?? '—' }, { label: 'Reason', render: r => r.reason }, { label: 'By', render: r => ({ factory: 'the factory', source: 'a source change' })[r.by] ?? r.by ?? 'the factory' }], data.failures, { caption: 'Failures and stops in this window' })) : empty('No failures or stops in this window')),
    section('Models', data.models.length ? card('', table([{ label: 'Provider and model', render: r => h('span', {}, h('strong', { text: r.model }), h('br'), h('span', { class: 'muted small', text: `${r.usedFor.join(', ')}${r.chosenPerTask ? ` · ${r.chosenPerTask} chosen per task or run` : ''}` })) }, { label: 'Invocations', render: r => String(r.steps) }, { label: 'Median', render: r => duration(r.medianMs) }, { label: 'Failed', render: r => `${r.failed} (${r.steps ? Math.round(r.failed / r.steps * 100) : 0}%)` },
      { label: 'Measured total tokens', render: r => h('span', { title: `Input ${r.tokens.input}, cached input ${r.tokens.cachedInput}, cache writes ${r.tokens.cacheWrite}, output ${r.tokens.output}` }, h('strong', { text: compact(r.totalTokens) }), h('br'), h('span', { class: 'muted small', text: `input-only ${compact(r.inputTokens)} · uncached ${compact(r.tokens.input)} · cached ${compact(r.tokens.cachedInput)} · written ${compact(r.tokens.cacheWrite)} · out ${compact(r.tokens.output)} · ${r.usageUnknown ?? 0} unknown` })) },
      { label: 'Estimate', render: r => r.usd === null ? h('span', { class: 'muted', text: 'unknown' }) : h('span', {}, h('strong', { text: fmt('usd', r.usd) }), h('br'), h('span', { class: 'muted small', text: `${fmt('usd', r.perStepUsd)} per step${r.unknown ? ` · ${r.unknown} unpriced` : ''}` })) }], data.models, { caption: 'Model invocations of work that ended in this window' })) : empty('No model steps in this window'), 'Measured token totals exclude unknown attribution. Input-only = uncached input + cache reads + cache writes; total = input-only + output. Reasoning is not added again.'),
    section('Tasks', grid(card_(b.created), card_(b.closed),
      card('Open now', kv([['Needs approval', String(open['needs-approval'])], ['Approved, not queued', String(open.approved)], ['Queued', String(open.queued)], ['Running', String(open.running)], ['Tracked, not workable', String(b.tracked)], ['Approved and waiting', b.approvedAge.count ? `${b.approvedAge.count} · median age ${duration(b.approvedAge.medianMs)} · oldest ${duration(b.approvedAge.oldestMs)}` : 'none']])),
      areaCard)),
    section('Maintenance', grid(card_(data.maintenance.metric), card('By operation', data.maintenance.rows.length ? table([{ label: 'Operation', render: r => r.operation }, { label: 'Runs', render: r => String(r.runs) }, { label: 'Failed', render: r => String(r.failed) }, { label: 'Median', render: r => duration(r.medianMs) }], data.maintenance.rows, { caption: 'Maintenance by operation' }) : empty('No maintenance in this window'), { cls: 'span-2' }))),
    // Knowledge upkeep: shown once it has recorded a run or counted an invocation in this window.
    ...(data.upkeep?.days?.length ? [section('Knowledge upkeep', grid(card('In this window', kv([['Mode', data.upkeep.mode], ['Runs recorded', String(data.upkeep.runs)], ['Model runs', String(data.upkeep.modelRuns)], ['Model invocations for upkeep', `${data.upkeep.upkeepInvocations} of ${data.upkeep.invocations} counted`], ['Last runs that reached the model', `${data.upkeep.lastRuns.reachedModel} of ${data.upkeep.lastRuns.count}`]])),
      card('Runs by outcome', Object.keys(data.upkeep.outcomes).length ? table([{ label: 'Outcome', render: r => r[0] }, { label: 'Runs', render: r => String(r[1]) }], Object.entries(data.upkeep.outcomes).sort((a, b) => b[1] - a[1]), { caption: 'Knowledge upkeep runs by outcome and reason' }) : empty('No run recorded in this window'), { cls: 'span-2' })), 'Invocations are counted when a model step settles, while upkeep is on. Observe mode records what it finds and creates nothing.')] : []));
}

// All projects: the same window for each, side by side; never summed across projects.
export function globalStats() {
  const projects = state.projects;
  if (!projects.length) return empty('No registered projects');
  const rows = projects.map(p => { if (!available(p)) return { p, st: null }; let e = readEntry(p, 'stats', '7d'); if (!e || (e.status === 'ready' && e.revision !== p.snapshot.revision)) { e = read(p, 'stats', '7d', {}, { force: Boolean(e), onDone: rerender }); e.revision = p.snapshot.revision; } return { p, st: e.data }; });
  const m = (st, list, id) => st?.[list]?.find(x => x.id === id);
  return h('div', { class: 'view stack' },
    notice('info', 'Last 7 days, per project.', 'Each project reports its own figures; unreachable projects are unknown, not zero, and nothing is summed across projects.'),
    card('Projects compared', table([
      { label: 'Project', render: r => h('a', { href: href({ projectId: r.p.projectId, tab: 'stats' }), text: r.p.name }) },
      { label: 'Changes merged', render: r => r.st ? fmt('count', m(r.st, 'throughput', 'merged').headline) : 'unknown' },
      { label: 'Tasks completed', render: r => r.st ? fmt('count', m(r.st, 'throughput', 'tasks').headline) : 'unknown' },
      { label: 'Failed', render: r => r.st ? fmt('count', m(r.st, 'throughput', 'failed').headline) : 'unknown' },
      { label: 'Start to merge', render: r => r.st ? fmt('duration', m(r.st, 'throughput', 'duration').headline) : 'unknown' },
      { label: 'First review passed', render: r => r.st ? fmt('percent', m(r.st, 'quality', 'first-review').headline) : 'unknown' },
      { label: 'Your response time', render: r => r.st ? fmt('duration', m(r.st, 'decisions', 'answered-operator').headline) : 'unknown' },
    ], rows, { caption: 'Last 7 days by project' })));
}
