// Factotum console entry: shell, routing, refresh and render orchestration.
import { taskForm, sourceTaskForm } from './ui/plan.mjs';
import { h, chip, notice, time, relative, empty, link, segmented, copyButton, backdropClick } from './ui/dom.mjs';
import { state, api, applyPrefs, prefs, TABS, parseRoute, href, navigate, rememberRoute, rememberedRoute, findProject, available, openItemCount, projectState, invalidateReads, setPref, detailParams } from './ui/state.mjs';
import { onCommandSettled, draftSummary } from './ui/actions.mjs';
import { globalOverview, projectOverview } from './ui/overview.mjs';
import { presenceControl } from './ui/presence.mjs';
import { inboxView, inboxItemForm, canPublishInbox } from './ui/inbox.mjs';
import { timelineView, flowDetail, flowDetailTitle } from './ui/timeline.mjs';
import { tasksView, taskDetailById } from './ui/plan.mjs';
import {queueView} from './ui/queue.mjs';
import { scheduledView } from './ui/scheduled.mjs';
import { historyView } from './ui/history.mjs';
import { projectStats, globalStats } from './ui/stats.mjs';
import { operationsView } from './ui/operations.mjs';
import { projectSettings, globalSettings } from './ui/settings.mjs';
import { receiptsView } from './ui/receipts.mjs';

const $ = selector => document.querySelector(selector);
$('#sidebar-toggle')?.addEventListener('click', () => setPref('sidebarCollapsed', !prefs.sidebarCollapsed));
const main = $('#main'), sidebar = $('#projects-nav'), tabs = $('#tabs'), statusBar = $('#observed'), banner = $('#banner'), scopeTitle = $('#scope-title');
let refreshing = false, timer = null, lastRouteKey = null, previousRevisions = new Map();

new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--topbar-height', `${entry.target.getBoundingClientRect().height}px`)).observe($('.topbar'));
applyPrefs();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

const VIEWS = {
  overview: { project: projectOverview, global: globalOverview },
  inbox: { project: p => inboxView(p, parseRoute()), global: () => inboxView(null, parseRoute()) },
  timeline: { project: timelineView }, tasks: { project: tasksView }, queue:{project:queueView}, scheduled: { project: scheduledView }, history: { project: historyView },
  stats: { project: projectStats, global: globalStats }, records: { project: operationsView },
  settings: { project: projectSettings, global: globalSettings },
  receipts: { project: receiptsView, global: () => receiptsView(null) },
};

function chooser(tab) {
  const label = TABS.find(t => t.id === tab).label;
  return h('div', { class: 'view' }, h('div', { class: 'card' }, h('h2', { class: 'card-title', text: `${label} is scoped to one project` }), h('p', { class: 'muted', text: 'Choose the project to open. Each project remains the authority for its own records and commands.' }),
    state.projects.length ? h('ul', { class: 'chooser' }, state.projects.map(p => h('li', {}, h('a', { href: href({ projectId: p.projectId, tab }), class: 'chooser-item' }, h('strong', { text: p.name }), chip(projectState(p).key, projectState(p).label))))) : empty('No registered projects')));
}

function renderSidebar(route) {
  const reachable = state.projects.filter(available);
  const totalOpen = reachable.reduce((n, p) => n + openItemCount(p), 0);
  const item = (projectId, name, statusNode, badge) => h('li', {}, h('a', { href: href({ projectId, tab: projectId || TABS.find(t => t.id === route.tab)?.scope !== 'project' ? route.tab : 'overview' }), class: (route.projectId ?? null) === projectId ? 'active' : '', 'aria-current': (route.projectId ?? null) === projectId ? 'page' : undefined },
    h('span', { class: 'nav-name', title: name }, statusNode, h('span', { text: name })), badge ? h('span', { class: 'badge', title: 'Open inbox items and to-dos', text: badge }) : null));
  sidebar.replaceChildren(h('ul', {},
    item(null, 'All projects', h('span', { class: 'dot dot-all', 'aria-hidden': 'true' }), totalOpen || null),
    state.projects.map(p => { const st = projectState(p); return item(p.projectId, p.name, h('span', { class: `dot status-${st.key}`, title: st.label, 'aria-label': st.label, role: 'img' }), (available(p) && openItemCount(p)) || (state.unresolved.has(p.projectId) ? '!' : null)); })));
  // Small screens get a select for the same navigation.
  const select = $('#project-select');
  select.replaceChildren(h('option', { value: '', text: 'All projects' }), ...state.projects.map(p => h('option', { value: p.projectId, text: `${p.name} — ${projectState(p).label}` })));
  select.value = route.projectId ?? '';
}

let shownTab = null;
function renderTabs(route, project) {
  tabs.replaceChildren(...TABS.map(tab => {
    const count = tab.id === 'inbox' ? (project ? (available(project) ? openItemCount(project) : null) : state.projects.filter(available).reduce((n, p) => n + openItemCount(p), 0)) : tab.id === 'tasks' ? (project && available(project) ? project.snapshot?.approvalNeededCount ?? null : null) : tab.id === 'receipts' ? state.journal.filter(c => !['completed', 'rejected'].includes(c.status) && (!project || c.projectId === project.projectId)).length : null;
    const scoped = tab.scope === 'project' && !project;
    return h('a', { href: href({ projectId: project?.projectId, tab: tab.id }), class: ['tab', route.tab === tab.id ? 'active' : '', scoped ? 'scoped' : ''], 'aria-current': route.tab === tab.id ? 'page' : undefined, title: scoped ? 'Choose a project first' : tab.id === 'tasks' && count ? `${count} task${count === 1 ? '' : 's'} need approval` : undefined }, tab.label, count ? h('span', { class: 'count', text: count, 'aria-label': tab.id === 'tasks' ? `${count} need approval` : undefined }) : null);
  }));
  // On a narrow screen the strip scrolls: bring the active tab into view whenever it changes (a link to another view, a deep link).
  if (shownTab !== route.tab) { shownTab = route.tab; tabs.querySelector('.tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' }); }
}

function renderStatus() {
  const age = state.observedAt ? Date.now() - Date.parse(state.observedAt) : null;
  const stale = state.refreshError || (age !== null && age > Math.max(30000, (prefs.refreshSeconds || 30) * 3000));
  statusBar.replaceChildren(...[
    h('span', { class: `live-dot ${stale ? 'stale' : ''}`, 'aria-hidden': 'true' }),
    state.observedAt ? h('span', { title: time(state.observedAt) }, `Observed ${relative(state.observedAt)}`) : h('span', { text: 'Not yet observed' }),
    state.refreshError ? h('span', { class: 'error-text', text: ` · refresh failed: ${state.refreshError}` }) : null,
    state.pendingRender ? h('button', { type: 'button', class: 'btn btn-small btn-primary', on: { click: () => render({ force: true }) } }, 'Show new data') : null].filter(Boolean));
}

function renderBanner() {
  banner.replaceChildren();
  if (state.message) banner.append(h('div', { class: `toast toast-${state.message.kind}` }, h('span', { text: state.message.text }), h('button', { type: 'button', class: 'btn btn-ghost btn-small', 'aria-label': 'Dismiss message', on: { click: () => { state.message = null; renderBanner(); } } }, 'Dismiss')));
}

// A re-render rebuilds the page; every scrolled panel (task list, timeline, record lists)
// gets its position back, keyed by its place in the page structure.
const scrollPath = (node, root = main) => { const parts = []; for (let n = node; n && n !== root; n = n.parentElement) parts.push(`${n.tagName}.${n.className}:${[...(n.parentElement?.children ?? [])].indexOf(n)}`); return parts.reverse().join('>'); };
const detailsKey = (node, root) => `${scrollPath(node, root)}|${node.querySelector(':scope > summary')?.textContent ?? ''}`;
function capture(root = main) {
  const active = document.activeElement;
  const inner = [root, ...root.querySelectorAll('*')].filter(n => n.scrollTop > 0 || n.scrollLeft > 0).map(n => [scrollPath(n, root), n.scrollTop, n.scrollLeft]);
  // Expanded sections (Edit labels, Edit brief, raw records…) stay as the user left them.
  const sections = [...root.querySelectorAll('details')].map(n => [detailsKey(n, root), n.open]);
  return { key: active?.dataset?.focusKey ?? null, id: active?.id || null, start: active?.selectionStart, end: active?.selectionEnd, scroll: window.scrollY, inner, sections };
}
// Sections are reopened before focus is restored: a control inside a closed section cannot take focus,
// and a grouped timeline marker builds the list below its chart as it opens (review of 3e4fdda, P2).
function restore(snapshot, root = main) {
  if (snapshot.sections?.length) { const byKey = new Map(snapshot.sections); for (const n of root.querySelectorAll('details')) { const open = byKey.get(detailsKey(n, root)); if (open !== undefined && n.open !== open) n.open = open; } }
  const target = (snapshot.key && document.querySelector(`[data-focus-key="${CSS.escape(snapshot.key)}"]`)) || (snapshot.id && document.getElementById(snapshot.id));
  if (target && target !== document.activeElement) { target.focus({ preventScroll: true }); try { if (snapshot.start !== null && snapshot.start !== undefined) target.setSelectionRange(snapshot.start, snapshot.end); } catch { /* not a text control */ } }
  if (snapshot.inner.length) { const byPath = new Map(snapshot.inner.map(([path, top, left]) => [path, [top, left]])); for (const n of [root, ...root.querySelectorAll('*')]) { const saved = byPath.get(scrollPath(n, root)); if (saved) { n.scrollTop = saved[0]; n.scrollLeft = saved[1]; } } }
  if (root === main) window.scrollTo({ top: snapshot.scroll });
}

function typing() {
  const active = document.activeElement;
  return active && (main.contains(active) || detailDialog.contains(active)) && (active.matches('textarea, input:not([type=button]):not([type=submit]):not([type=search])')) && Date.now() - (state.typingAt ?? 0) < 20000;
}

export function render({ force = false, routeChanged = false } = {}) {
  const route = parseRoute();
  if (!force && !routeChanged && typing()) { state.pendingRender = true; renderStatus(); return; }
  state.pendingRender = false;
  const project = route.projectId ? findProject(route.projectId) : null;
  const snapshot = capture(), opener = describeControl(document.activeElement);
  renderSidebar(route); renderTabs(route, project); renderStatus(); renderBanner(); renderNewTask(); renderNewInboxItem();
  const tab = TABS.find(t => t.id === route.tab);
  scopeTitle.textContent = project ? project.name : 'All projects';
  $('#operator-presence').replaceChildren(presenceControl(project));
  document.title = `${tab.label} · ${project ? project.name : 'All projects'} — Factotum`;
  let view;
  // Without one successful read the console does not know the registrations: a failed refresh is not a registry fact.
  if (route.projectId && !project && !state.observedAt && state.refreshError) view = notice('error', 'Projects could not be loaded.', `The console could not read its project list (${state.refreshError}). This says nothing about whether ${route.projectId} is registered. Use Refresh to try again.`);
  else if (route.projectId && !project) view = state.loading ? h('div', { class: 'skeleton', text: 'Loading…' }) : notice('warning', 'Project not registered.', `No active registration matches ${route.projectId}. Links never fall back to another project.`, link(href({ tab: 'overview' }), ' Open all projects'));
  else if (project) view = VIEWS[route.tab].project(project, route);
  else view = VIEWS[route.tab].global ? VIEWS[route.tab].global(route) : chooser(route.tab);
  const heading = h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, tab.label, project ? h('span', { class: 'muted', text: ` · ${project.name}` }) : null);
  const drafts = draftSummary(project?.projectId);
  main.replaceChildren(h('div', { class: 'page-head' }, heading, project ? chip(projectState(project).key, projectState(project).label) : null), drafts ?? '', view);
  if (routeChanged) { window.scrollTo({ top: 0 }); heading.focus({ preventScroll: true }); }
  else restore(snapshot);
  renderDetail(route, project, opener);
  // Closing the detail returns focus to the row or link that opened it, not to the page container.
  // A link inside a list that has closed since (a grouped timeline marker closes on navigation) gives focus to that list's summary.
  if (returnFocus && !detailDialog.open) { const target = findControl(returnFocus); returnFocus = null; (target?.closest('details:not([open])')?.querySelector(':scope > summary') ?? target)?.focus(); }
}
// A control identified so it can be found again after the page is rebuilt.
function describeControl(node) {
  if (!node || node === document.body || node === main || detailDialog?.contains(node)) return null;
  return { key: node.dataset?.focusKey ?? null, href: node.getAttribute?.('href') ?? null, label: node.getAttribute?.('aria-label') ?? null };
}
function findControl(spec) {
  // Its own key first: several links can share an address (a flow's bar and its event in a grouped marker's list).
  const controls = [...main.querySelectorAll('a, button')];
  return (spec.key && controls.find(n => n.dataset.focusKey === spec.key)) || (spec.href && controls.find(n => n.getAttribute('href') === spec.href)) || (spec.label && controls.find(n => n.getAttribute('aria-label') === spec.label)) || null;
}

// Shared detail modal: ?flow=<id> (or ?task=<id> outside Tasks) opens over any project page, so a
// flow or task link works anywhere and the address can be shared.
const detailDialog = $('#detail-dialog'); let closingByRoute = false, detailKey = null, detailOpener = null, returnFocus = null;
function renderDetail(route, project, opener = null) {
  const flowId = route.params.flow, taskId = route.tab !== 'tasks' ? route.params.task : null;
  if (!project || (!flowId && !taskId)) { if (detailDialog.open) { closingByRoute = true; detailDialog.close(); } detailKey = null; return; }
  const key = `${project.projectId}|${flowId ?? ''}|${taskId ?? ''}`, snapshot = key === detailKey ? capture(detailDialog) : null; detailKey = key;
  const title = flowId ? flowDetailTitle(project, flowId) : (project.snapshot?.tasks ?? []).find(t => t.id === taskId)?.title ?? `Task ${taskId}`;
  const body = !available(project) ? notice('warning', `${project.name} is ${project.status}.`, 'Details are read from the project service and are unavailable until it responds.') : flowId ? flowDetail(project, flowId, route) : taskDetailById(project, taskId);
  const copy = copyButton('Copy link', () => location.href);
  detailDialog.replaceChildren(h('div', { class: 'modal-head' }, h('div', {}, h('p', { class: 'muted small', text: `${flowId ? 'Flow' : 'Task'} · ${project.name}` }), h('h2', { id: 'detail-title', text: title })), h('div', { class: 'button-row' }, copy, h('button', { type: 'button', class: 'btn btn-secondary btn-small', text: 'Close', on: { click: () => detailDialog.close() } }))), body);
  if (!detailDialog.open) { detailOpener = opener; detailDialog.showModal(); }
  if (snapshot) restore(snapshot, detailDialog);
}
detailDialog.addEventListener('close', () => {
  if (closingByRoute) { closingByRoute = false; return; }
  returnFocus = detailOpener; detailOpener = null;
  const route = parseRoute(); navigate({ ...route, params: detailParams(route) });
});
// Only a click outside the window (on the backdrop) closes it, or Escape; never a click on its own blank space.
detailDialog.addEventListener('click', event => { if (backdropClick(detailDialog, event)) detailDialog.close(); });

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const [projects, journal] = await Promise.all([api('/api/projects'), api('/api/reconcile', {})]);
    state.projects = projects; state.journal = journal; state.loading = false; state.refreshError = null;
    state.unresolved = new Set(journal.filter(c => !['completed', 'rejected'].includes(c.status)).map(c => c.projectId));
    state.observedAt = new Date().toISOString();
    for (const p of projects) { const rev = p.snapshot?.revision; if (previousRevisions.get(p.projectId) !== rev) invalidateReads(p.projectId); previousRevisions.set(p.projectId, rev); }
  } catch (error) {
    state.refreshError = error.status === 403 ? 'console session expired; reload the page' : error.message; state.loading = false;
    // An expired session stays expired: stop polling until the page is reloaded (Refresh still tries once).
    if (error.status === 403) { clearInterval(timer); timer = null; state.sessionExpired = true; }
  }
  finally { refreshing = false; }
  render({ force });
}

function schedule() { clearInterval(timer); if (prefs.refreshSeconds > 0 && !state.sessionExpired) timer = setInterval(() => refresh(false), prefs.refreshSeconds * 1000); }

onCommandSettled(async (project, options = {}) => { if (options.renderOnly) render({ force: true }); else await refresh(true); });
window.addEventListener('factotum:render', () => render({ force: !typing() }));
window.addEventListener('hashchange', () => {
  const route = parseRoute(), key = `${route.projectId}|${route.tab}`;
  rememberRoute(); render({ routeChanged: key !== lastRouteKey, force: true }); lastRouteKey = key;
});
window.addEventListener('storage', event => { if (event.key === 'factotum.prefs') { Object.assign(prefs, JSON.parse(event.newValue ?? '{}')); applyPrefs(); schedule(); } });
$('#refresh').addEventListener('click', () => refresh(true));
// New task opens in a dialog from the project header; the form keeps its draft between openings.
const newTaskButton = $('#new-task'), newTaskDialog = $('#new-task-dialog'); let newTaskWhere = null;
function renderNewTask() {
  const project = findProject(parseRoute().projectId);
  newTaskButton.hidden = !(project && available(project));
  if (!newTaskDialog.open || !project) return;
  // Prefer creating in the issue source when it supports it; a local task stays available.
  const canCreate = project.snapshot.sourceSync?.capabilities?.create === true, where = canCreate ? (newTaskWhere ?? 'source') : 'local';
  const sourceName = project.snapshot.sourceSync?.type === 'github' ? 'GitHub' : 'Task source';
  newTaskDialog.replaceChildren(h('div', { class: 'modal-head' }, h('h2', { id: 'new-task-title', text: `New task · ${project.name}` }), h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Close', on: { click: () => newTaskDialog.close() } })),
    canCreate ? segmented([['source', `In ${sourceName}`], ['local', 'Local only']], where, value => { newTaskWhere = value; renderNewTask(); }, 'Where to create the task') : null,
    where === 'source' ? sourceTaskForm(project, { onCompleted: () => newTaskDialog.close() }) : taskForm(project, null, { onCompleted: receipt => {
      // The new task replaces the cleared form: close the dialog and open the task.
      newTaskDialog.close(); const taskId = receipt.receipt?.result?.id;
      if (taskId) navigate({ projectId: project.projectId, tab: 'tasks', params: { task: taskId } });
    } }));
}
newTaskButton.addEventListener('click', () => { newTaskDialog.showModal(); renderNewTask(); });
// New inbox item works the same way, from the header on the Inbox tab.
const newInboxButton = $('#new-inbox-item'), newInboxDialog = $('#new-inbox-dialog');
function renderNewInboxItem() {
  const route = parseRoute(), project = findProject(route.projectId);
  newInboxButton.hidden = !(route.tab === 'inbox' && canPublishInbox(project));
  if (!newInboxDialog.open) return;
  if (!canPublishInbox(project)) { newInboxDialog.close(); return; }
  newInboxDialog.replaceChildren(h('div', { class: 'modal-head' }, h('h2', { id: 'new-inbox-title', text: `New inbox item · ${project.name}` }), h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'Close', on: { click: () => newInboxDialog.close() } })), inboxItemForm(project));
}
newInboxButton.addEventListener('click', () => { newInboxDialog.showModal(); renderNewInboxItem(); });
$('#project-select').addEventListener('change', event => navigate({ projectId: event.target.value || null, tab: parseRoute().tab }));
tabs.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const links = [...tabs.querySelectorAll('a')], index = links.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length;
  links[next].focus();
});
document.addEventListener('keydown', event => { if (event.key === 'r' && event.altKey) { event.preventDefault(); refresh(true); } });
setInterval(renderStatus, 5000);
window.addEventListener('factotum:prefs', schedule);

if (!location.hash && rememberedRoute()) history.replaceState(null, '', rememberedRoute());
lastRouteKey = `${parseRoute().projectId}|${parseRoute().tab}`;
render({ force: true });
await refresh(true);
schedule();
