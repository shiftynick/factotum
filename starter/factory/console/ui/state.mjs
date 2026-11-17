import { flowName, tag } from './dom.mjs';
// Browser state. Nothing here is authority: project services validate every command.
const csrf = document.querySelector('meta[name="factotum-csrf"]').content;

function load(storage, key, fallback) { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(storage, key, value) { try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ } }

/** Display preferences live only in this browser and never change project policy. */
export const prefs = Object.assign({ theme: 'system', density: 'comfortable', timeZone: 'local', refreshSeconds: 10, sidebarCollapsed: false }, load(localStorage, 'factotum.prefs', {}));
export function setPref(key, value) { prefs[key] = value; save(localStorage, 'factotum.prefs', prefs); applyPrefs(); window.dispatchEvent(new Event('factotum:prefs')); }
export function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.sidebar = prefs.sidebarCollapsed ? 'collapsed' : 'expanded';
  const toggle = document.getElementById('sidebar-toggle');
  if (toggle) { const label = prefs.sidebarCollapsed ? 'Expand projects panel' : 'Collapse projects panel'; toggle.setAttribute('aria-expanded', String(!prefs.sidebarCollapsed)); toggle.setAttribute('aria-label', label); toggle.title = label; toggle.textContent = prefs.sidebarCollapsed ? '›' : '‹'; }
}

export const state = {
  projects: [], journal: [], unresolved: new Set(), observedAt: null, refreshError: null, loading: true,
  pendingRender: false, message: null,
  reads: new Map(), // projectId|bindingId|path -> { status, data, error, fetchedAt, promise }
  ui: load(sessionStorage, 'factotum.ui', {}), // per-view ephemeral choices (filters, selections)
};
export function saveUi() { save(sessionStorage, 'factotum.ui', state.ui); }
export function uiState(key, defaults = {}) { state.ui[key] = { ...defaults, ...(state.ui[key] ?? {}) }; return state.ui[key]; }

export async function api(path, body) {
  const response = await fetch(path, body === undefined ? { headers: { accept: 'application/json' } } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-factotum-csrf': csrf }, body: JSON.stringify(body) });
  let result;
  try { result = await response.json(); } catch { throw Error(`Console returned HTTP ${response.status} without JSON`); }
  if (!response.ok) throw Object.assign(Error(result.error || `HTTP ${response.status}`), { status: response.status });
  return result;
}

// ---- Routing: #/all/<tab> or #/p/<projectId>/<tab>?key=value ----------------------------------
export const TABS = [
  { id: 'overview', label: 'Overview', scope: 'both' },
  { id: 'inbox', label: 'Inbox', scope: 'both' },
  { id: 'timeline', label: 'Timeline', scope: 'project' },
  { id: 'tasks', label: 'Tasks', scope: 'project' },
  { id: 'queue', label: 'Queue', scope: 'project' },
  { id: 'scheduled', label: 'Scheduled', scope: 'project' },
  { id: 'history', label: 'History', scope: 'project' },
  { id: 'stats', label: 'Stats', scope: 'both' },
  { id: 'records', label: 'Health', scope: 'project' },
  { id: 'settings', label: 'Settings', scope: 'both' },
  { id: 'receipts', label: 'Receipts', scope: 'both' },
];
export function parseRoute(hash = globalThis.location?.hash ?? '') {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if(parts[0]==='p'&&parts[2]==='plan')parts[2]='tasks';
  if(parts[0]==='all'&&parts[1]==='plan')parts[1]='tasks';
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: TABS.some(t => t.id === parts[2]) ? parts[2] : 'overview', params };
  return { projectId: null, tab: TABS.some(t => t.id === parts[1]) ? parts[1] : 'overview', params };
}
export function href({ projectId = null, tab = 'overview', params = {} } = {}) {
  if(tab==='plan')tab='tasks';
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return `#/${projectId ? `p/${encodeURIComponent(projectId)}` : 'all'}/${tab}${query ? `?${query}` : ''}`;
}
export function navigate(route, { replace = false } = {}) {
  const target = href(route);
  if (location.hash === target) return window.dispatchEvent(new HashChangeEvent('hashchange'));
  if (replace) history.replaceState(null, '', target), window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
export function patchRoute(params, options) { const route = parseRoute(); navigate({ ...route, params: { ...route.params, ...params } }, options); }
// The shared detail modal opens over the current page: ?flow=<id> or ?task=<id>. On Tasks,
// ?task selects the task inline, so a task link there closes any open flow detail.
export function detailParams(route, { flow, task } = {}) {
  const params = { ...route.params, flow: undefined, attempt: undefined };
  if (route.tab !== 'tasks') params.task = undefined;
  if (flow) params.flow = flow; else if (task) params.task = task;
  return params;
}
export function detailHref({ flow, task, projectId } = {}, route = parseRoute()) {
  // From another project's (or the all-projects) page, open the detail over the same tab of the target project.
  const target = projectId && projectId !== route.projectId ? { projectId, tab: route.tab, params: {} } : route;
  return href({ projectId: target.projectId, tab: target.tab, params: detailParams(target, { flow, task }) });
}
export function rememberRoute() { save(localStorage, 'factotum.route', location.hash); }
export function rememberedRoute() { return load(localStorage, 'factotum.route', null); }

// ---- Project helpers -----------------------------------------------------------------------
export const findProject = projectId => state.projects.find(p => p.projectId === projectId);
export const available = project => project?.status === 'available';
export const openDecisions = project => (project?.snapshot?.inbox ?? []).filter(item => item.status === 'open');
// Obligations still owed (post-merge steps, source closure, failed cleanup): Inbox to-dos.
export const openObligation = o => !['passed', 'failed', 'deferred'].includes(o.status);
export const openTodos = project => (project?.snapshot?.obligations ?? []).filter(openObligation);
// One open-item count everywhere (sidebar, tabs, Overview): open inbox items plus open to-dos.
export const openItemCount = project => openDecisions(project).length + openTodos(project).length;
// Delivery admission is held until doctor passes for the current configuration.
export const commissioningRequired = project => Boolean(project?.snapshot && (project.snapshot.commissioningRequired ?? project.snapshot.settings?.commissioningRequired));
export const activeFlows = project => (project?.snapshot?.flows ?? []).filter(f => !['completed', 'failed'].includes(f.state));
export function projectState(project) {
  if (!project) return { key: 'unknown', label: 'Unknown' };
  if (project.status !== 'available') return { key: project.status, label: project.status === 'incompatible' ? 'Incompatible' : 'Unavailable' };
  const s = project.snapshot;
  if (s.recoveryHold) return { key: 'hold', label: 'Recovery hold' };
  if (commissioningRequired(project)) return { key: 'hold', label: 'Commissioning required' };
  if (s.paused) return { key: 'paused', label: 'Paused' };
  if (activeFlows(project).some(f => f.state !== 'stopped')) return { key: 'active', label: 'Active' };
  if (activeFlows(project).length) return { key: 'stopped', label: 'Stopped work' };
  return { key: 'idle', label: 'Idle' };
}

// ---- Lazy canonical reads, cached per project binding ---------------------------------------
export function readPath(project, kind, subject, query = {}) {
  return `/api/project/${encodeURIComponent(project.projectId)}/${kind}/${encodeURIComponent(subject)}?${new URLSearchParams({ bindingId: project.bindingId, ...query })}`;
}
export function readEntry(project, kind, subject, query = {}) {
  return state.reads.get(`${project.projectId}|${project.bindingId}|${readPath(project, kind, subject, query)}`);
}
/** Starts (or reuses) a read; onDone triggers a re-render. Results stay tied to the binding that produced them. */
export function read(project, kind, subject, query = {}, { force = false, onDone } = {}) {
  const path = readPath(project, kind, subject, query), key = `${project.projectId}|${project.bindingId}|${path}`;
  const existing = state.reads.get(key);
  if (existing && !force) return existing; // errors are retried explicitly, never in a render loop
  const entry = { status: 'loading', data: existing?.data, fetchedAt: existing?.fetchedAt, error: null };
  state.reads.set(key, entry);
  entry.promise = api(path).then(data => { Object.assign(entry, { status: 'ready', data, fetchedAt: new Date().toISOString() }); }, error => { Object.assign(entry, { status: 'error', error: error.message }); }).finally(() => onDone?.());
  return entry;
}
export function invalidateReads(projectId) { for (const key of state.reads.keys()) if (key.startsWith(`${projectId}|`)) state.reads.get(key).stale = true; }

// A flow's display name from the project snapshot, falling back to its short tag.
export function flowTitle(project, flowId) {
  const flow = (project?.snapshot?.flows ?? []).find(row => row.id === flowId);
  return flow ? flowName(flow) : `Flow ${tag(flowId)}`;
}
