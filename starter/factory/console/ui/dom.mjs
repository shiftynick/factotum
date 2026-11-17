// DOM and formatting helpers. All untrusted content is assigned as text; no HTML parsing.
import { prefs } from './state.mjs';

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, v);
    else if (key in node && !key.startsWith('aria') && key !== 'role' && key !== 'for') node[key] = value;
    else node.setAttribute(key === 'for' ? 'for' : key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
export const text = value => document.createTextNode(String(value ?? ''));
// A click on a modal dialog's backdrop: the dialog element is the target of a click on its backdrop
// and of a click on its own padding alike, so only the click's position tells them apart (dev.88 M5:
// a click on blank space inside the flow window closed it). A click with no position (from the
// keyboard) is never a backdrop click.
export function backdropClick(dialog, event) {
  if (event.target !== dialog || !(event.clientX || event.clientY)) return false;
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}
export const json = value => JSON.stringify(value ?? null, null, 2);

// ---- Time and number formatting -------------------------------------------------------------
export const ms = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function zone() { return prefs.timeZone === 'utc' ? 'UTC' : undefined; }
export function time(value, { date = true, seconds = true, fraction = 0, zone: named = true } = {}) {
  const t = ms(value); if (t === null) return '—';
  // Every time names its zone (the browser's, or UTC by preference); axis ticks pass zone: false.
  const options = { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), ...(fraction ? { fractionalSecondDigits: fraction } : {}), hour12: false, timeZone: zone(), ...(named ? { timeZoneName: 'short' } : {}) };
  if (date) Object.assign(options, { year: 'numeric', month: 'short', day: '2-digit' });
  return new Intl.DateTimeFormat(undefined, options).format(new Date(t));
}
// Recorded text (hold reasons, notices, stop reasons) can embed raw ISO timestamps; show them as
// times in the operator's zone, like every other time on the page.
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
// The ISO times written in a text, for a record that has no structured times (dev.86).
export const isoTimesIn = value => typeof value === 'string' ? [...new Set(value.match(ISO_TIME) ?? [])].filter(match => ms(match) !== null) : [];
export const localizeTimes = value => typeof value === 'string' ? value.replace(ISO_TIME, match => ms(match) === null ? match : time(match)) : value;
export function duration(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  const s = value / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60), rs = Math.round(s % 60);
  if (m < 60) return `${m} min ${rs ? `${rs} s` : ''}`.trim();
  const hr = Math.floor(m / 60), rm = m % 60;
  if (hr < 48) return `${hr} h ${rm ? `${rm} min` : ''}`.trim();
  return `${Math.floor(hr / 24)} d ${hr % 24} h`;
}
export function relative(value, now = Date.now()) {
  const t = ms(value); if (t === null) return '—';
  const delta = t - now, abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  for (const [unit, size] of units) if (abs >= size || unit === 'second') return formatter.format(Math.round(delta / size), unit);
  return '';
}
export const between = (a, b) => { const x = ms(a), y = ms(b); return x !== null && y !== null && y >= x ? y - x : null; };
export const usd = micros => Number.isFinite(micros) ? `USD ${(micros / 1e6).toFixed(micros % 10000 ? 6 : 2)}` : 'unknown';
// Human labels for opaque identifiers: a 4-character tag, and a flow named by its
// workflow and task rather than its UUID.
export const tag = id => typeof id !== 'string' || !id ? '' : id.length <= 10 ? `#${id}` : `#${id.replace(/[^a-z0-9]/gi, '').slice(0, 4)}`;
const workflowKind = flow => flow?.workflowName ? flow.workflowName.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase()) : ({ change: 'Change', planning: 'Planning', maintenance: 'Maintenance' })[flow?.kind] ?? (flow?.kind ? flow.kind.replace(/^\w/, c => c.toUpperCase()) : 'Flow');
export const flowName = flow => {
  if (!flow) return 'Flow';
  const title = String(flow.taskSnapshot?.title ?? flow.taskId ?? '').replace(/^Maintenance:\s*/, ''), text = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  return `${workflowKind(flow)}${text ? ` · ${text}` : ''} ${tag(flow.id)}`;
};
export const short = (value, n = 10) => typeof value === 'string' && value.length > n + 1 ? `${value.slice(0, n)}…` : String(value ?? '—');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const titleCase = value => String(value ?? '').replace(/[-_.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ---- Status vocabulary ----------------------------------------------------------------------
const tones = {
  good: ['completed', 'passed', 'answered', 'accepted', 'green', 'available', 'ready', 'approved', 'consumed', 'settled', 'merged', 'pass', 'resolved', 'idle', 'enabled'],
  info: ['tracked', 'running', 'dispatching', 'active', 'ready-to-run', 'launching', 'open', 'queued', 'claimed', 'pending', 'sending', 'proposed', 'reported', 'planning'],
  wait: ['waiting', 'prepared', 'reserved', 'paused', 'unapproved', 'draft', 'deferred'],
  warn: ['approval-required', 'stopped', 'uncertain', 'unknown', 'unavailable', 'incompatible', 'expired', 'stale', 'superseded', 'revoked', 'hold', 'red-unknown', 'blocked', 'overrun', 'revise', 'held', 'turn-limit'],
  bad: ['failed', 'rejected', 'red', 'aborted', 'error', 'fail'],
  muted: ['not-dispatched', 'removed', 'cancelled', 'disabled', 'none'],
};
const icons = { good: '✓', info: '●', wait: '◔', warn: '▲', bad: '✕', muted: '○' };
export function tone(status) {
  const value = String(status ?? 'unknown').toLowerCase();
  for (const [name, list] of Object.entries(tones)) if (list.includes(value)) return name;
  return 'muted';
}
// label: text, or a list of text and nodes (for example a time element with its recorded value as tooltip).
export function chip(status, label = status, extra) {
  const t = tone(status);
  return h('span', { class: ['chip', `tone-${t}`, extra], title: extra ? undefined : undefined }, h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: icons[t] }), Array.isArray(label) ? label : String(label ?? 'unknown'));
}
export function pill(textValue, cls = '') { return h('span', { class: `pill ${cls}`, text: textValue }); }

// ---- Structure helpers ----------------------------------------------------------------------
export function card(title, body, { actions, cls, id, subtitle, level = 'h3' } = {}) {
  return h('section', { class: ['card', cls], id, 'aria-label': typeof title === 'string' ? title : undefined },
    (title || actions) ? h('header', { class: 'card-head' }, h('div', {}, title ? h(level, { class: 'card-title', text: title }) : null, subtitle ? h('p', { class: 'card-sub', text: subtitle }) : null), actions ? h('div', { class: 'card-actions' }, actions) : null) : null,
    body);
}
export function kv(rows, cls = '') {
  const list = h('dl', { class: `kv ${cls}` });
  for (const [label, value] of rows) {
    if (value === undefined) continue;
    list.append(h('dt', { text: label }), h('dd', {}, value === null || value === '' ? h('span', { class: 'muted', text: '—' }) : value));
  }
  return list;
}
export function empty(title, detail, action) {
  return h('div', { class: 'empty', role: 'note' }, h('p', { class: 'empty-title', text: title }), detail ? h('p', { class: 'muted', text: detail }) : null, action ?? null);
}
export function notice(kind, title, detail, extra) {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'note' }, h('strong', { text: title }), detail ? h('span', {}, ' ', detail) : null, extra ?? null);
}
export function raw(label, value) {
  return h('details', { class: 'raw' }, h('summary', { text: label }), h('pre', { class: 'code', text: typeof value === 'string' ? value : json(value) }));
}
export function table(columns, rows, { onRow, rowLabel, selected, caption, cls } = {}) {
  const wrap = h('div', { class: ['table-wrap', cls] });
  const t = h('table', { class: 'data' });
  if (caption) t.append(h('caption', { class: 'sr-only', text: caption }));
  t.append(h('thead', {}, h('tr', {}, columns.map(c => h('th', { scope: 'col', class: c.cls, text: c.label })))));
  const body = h('tbody');
  for (const row of rows) {
    // The whole row opens it; the first cell's button keeps it keyboard reachable.
    const tr = h('tr', { class: [selected && selected(row) ? 'selected' : '', onRow ? 'clickable' : ''], on: onRow ? { click: event => { if (!event.target.closest('a, button, input, select, textarea, summary')) onRow(row); } } : undefined });
    columns.forEach((c, index) => {
      const value = c.render ? c.render(row) : row[c.key];
      const cell = h(index === 0 ? 'th' : 'td', { class: c.cls, ...(index === 0 ? { scope: 'row' } : {}) });
      if (index === 0 && onRow) cell.append(h('button', { type: 'button', class: 'link-button', 'aria-label': rowLabel ? rowLabel(row) : undefined, on: { click: () => onRow(row) } }, value ?? '—'));
      else cell.append(value instanceof Node ? value : text(value ?? '—'));
      tr.append(cell);
    });
    body.append(tr);
  }
  t.append(body); wrap.append(t);
  return wrap;
}
export function list(items, render, cls = 'plain-list') { return h('ul', { class: cls }, items.map(item => h('li', {}, render(item)))); }
export function strings(values, emptyText = 'None recorded') {
  return Array.isArray(values) && values.length ? h('ul', { class: 'bullets' }, values.map(v => h('li', { text: typeof v === 'string' ? v : json(v) }))) : h('span', { class: 'muted', text: emptyText });
}
export function link(href, label, attrs = {}) { return h('a', { href, ...attrs }, label); }

// ---- Links built from record data ------------------------------------------------------------
// A URL a record carries is never trusted as an href. Forge links are built from the configured
// repository (host and slug) and a validated number or commit; a recorded forge URL is accepted
// only as https, without credentials, on the configured host and under the repository's path.
// Other external links must be https (or a listed scheme) without credentials. Anything else is
// shown as text, not linked.
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$/, SHA = /^[a-f\d]{40,64}$/i;
export function forgeBase(repo) {
  const host = repo?.hostname ?? 'github.com';
  return typeof repo?.slug === 'string' && SLUG.test(repo.slug) && !repo.slug.split('/').some(part => /^\.+$/.test(part)) && typeof host === 'string' && HOST.test(host) ? `https://${host}/${repo.slug}` : null;
}
export function forgeUrl(repo, value) {
  const base = forgeBase(repo);
  if (!base || typeof value !== 'string') return null;
  let url; try { url = new URL(value); } catch { return null; }
  const expected = new URL(base), path = url.pathname.toLowerCase(), prefix = expected.pathname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.host.toLowerCase() !== expected.host.toLowerCase()) return null;
  return path === prefix || path.startsWith(`${prefix}/`) ? url.href : null;
}
export const forgePull = (repo, number) => { const base = forgeBase(repo); return base && Number.isSafeInteger(number) && number > 0 ? `${base}/pull/${number}` : null; };
export const forgeCommit = (repo, head) => { const base = forgeBase(repo); return base && typeof head === 'string' && SHA.test(head) ? `${base}/commit/${head}` : null; };
export const forgeCompare = (repo, from, to) => { const base = forgeBase(repo); return base && [from, to].every(v => typeof v === 'string' && SHA.test(v)) ? `${base}/compare/${from}...${to}` : null; };
export function safeUrl(value, schemes = ['https:']) {
  if (typeof value !== 'string') return null;
  let url; try { url = new URL(value); } catch { return null; }
  return schemes.includes(url.protocol) && !url.username && !url.password ? url.href : null;
}
// A link when the URL passed validation; otherwise the label alone (and the rejected value as text when asked).
export function externalLink(url, label, { fallback = null, ...attrs } = {}) {
  return url ? link(url, label, { target: '_blank', rel: 'noreferrer', ...attrs }) : h('span', { text: fallback ?? label });
}
export function button(label, onClick, { variant = 'secondary', disabled, title, ...attrs } = {}) {
  return h('button', { type: 'button', class: `btn btn-${variant}`, disabled, title, on: { click: onClick }, ...attrs }, label);
}
// Copies a value and says whether it worked. The button is kept from the start: after the
// clipboard's await, the click event no longer has a currentTarget.
export function copyButton(label, value) {
  const node = h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: label, on: { click: async () => {
    try { await navigator.clipboard.writeText(value()); node.textContent = 'Copied'; } catch { node.textContent = 'Copy failed'; }
  } } });
  return node;
}
export function segmented(options, value, onChange, label) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(([key, name, count]) => h('button', { type: 'button', class: key === value ? 'active' : '', 'aria-pressed': String(key === value), on: { click: () => onChange(key) } }, name, count !== undefined ? h('span', { class: 'count', text: count }) : null)));
}
