// dev.90: the console findings of the dev.89 readiness re-test. N3: the finding and candidate
// confirmations named only the project. N4: one finding time was shown both as a date and as a
// relative time. Fictional fixtures; see docs/changes/dev90-n-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 1200;
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');

const AT = '2026-11-16T19:59:41.143Z', STATUS_AT = '2026-11-16T20:39:45.346Z';
const finding = (status, extra = {}) => ({ id: `audit:fictional-${status}`, source: 'audit', title: `Fictional ${status} finding`, status, version: 5, severity: 'medium', evidence: 'fictional.mjs:12', observations: 1, createdAt: AT, statusAt: STATUS_AT, ...extra });
const candidate = (status, extra = {}) => ({ id: `upkeep:fictional-${status}`, source: 'upkeep', kind: 'docs', title: `Fictional ${status} candidate`, status, version: 3, file: 'docs/FICTION.md', createdAt: AT, statusAt: STATUS_AT, ...extra });
function project({ findings = [], upkeep = null } = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], findings, ...(upkeep ? { upkeep } : {}),
    settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } };
}
async function confirmations(view) {
  const asked = [], sent = [];
  globalThis.window.confirm = text => { asked.push(text); return false; };
  globalThis.fetch = async (...args) => { sent.push(args); throw new Error('nothing may be sent'); };
  const forms = byTag(view, 'form').filter(form => /^(Decline|Record as resolved elsewhere|Reopen) — /.test(form.attributes['aria-label'] ?? ''));
  for (const form of forms) for (const handler of form.handlers.submit ?? []) await handler({ preventDefault() {} });
  assert.deepEqual(sent, [], 'a refused confirmation sends nothing');
  return asked.map(text => { const [question, , target] = text.split('\n'); assert.equal(target, 'Target: Fictional project'); return question; }).sort();
}

test('N3: each finding confirmation names the finding, its title and version, and the task a decline would close', async () => {
  const asked = await confirmations(operationsView(project({ findings: [finding('unapproved'), finding('tasked', { taskId: 'task-1' }), finding('declined')] })));
  assert.ok(asked.every(text => !/this finding/.test(text)), 'dev.89: "Decline this finding?" and the project name only');
  assert.deepEqual(asked, [
    'Decline finding audit:fictional-tasked “Fictional tasked finding” (version 5)? Its task task-1 is closed too.',
    'Decline finding audit:fictional-unapprov… “Fictional unapproved finding” (version 5)?',
    'Record finding audit:fictional-tasked “Fictional tasked finding” (version 5) as dealt with another way? Its task task-1 is closed if it has not started.',
    'Record finding audit:fictional-unapprov… “Fictional unapproved finding” (version 5) as dealt with another way?',
    'Reopen finding audit:fictional-declined “Fictional declined finding” (version 5)? It returns to the open findings.',
  ].sort());
});

test('N3: an upkeep candidate\'s confirmations say candidate, with its version and the follow-up task they close', async () => {
  const upkeep = { mode: 'propose', suspensions: [], candidates: [], tasked: [candidate('tasked', { taskId: 'upkeep:docs:fictional' })], closed: [candidate('declined', { disposition: { status: 'declined', reason: 'unnecessary', by: 'operator', at: STATUS_AT } })], followUp: null };
  const asked = await confirmations(operationsView(project({ upkeep })));
  assert.deepEqual(asked, [
    'Decline upkeep candidate upkeep:fictional-tasked “Fictional tasked candidate” (version 3)? Its task upkeep:docs:fictional is closed too.',
    'Record upkeep candidate upkeep:fictional-tasked “Fictional tasked candidate” (version 3) as dealt with another way? Its task upkeep:docs:fictional is closed if it has not started.',
    'Reopen upkeep candidate upkeep:fictional-declined “Fictional declined candidate” (version 3)? It returns to the waiting candidates.',
  ].sort());
  // A long title is cut, and text is never parsed: the dialog gets it as plain text.
  const long = await confirmations(operationsView(project({ findings: [finding('unapproved', { title: `<b>${'x'.repeat(300)}</b>` })] })));
  assert.ok(long.every(text => text.length < 260 && text.includes('“<b>xxx')));
});

test('N4: a finding\'s status time is shown once, as a date; the disposition does not repeat it as "1 hour ago"', () => {
  const declined = finding('declined', { disposition: { status: 'declined', reason: 'unnecessary', by: 'operator', at: STATUS_AT } });
  const view = operationsView(project({ findings: [declined] }));
  const times = byTag(view, 'time').filter(node => node.attributes.datetime === STATUS_AT);
  assert.equal(times.length, 1, 'dev.89: the same time under "Status changed" and, relative, under "Disposition"');
  assert.equal(times[0].attributes.title, `${STATUS_AT} (UTC as recorded)`);
  assert.doesNotMatch(times[0].textContent, /ago|in \d/, 'shown as a date, not a relative time');
  // A disposition time that differs from the status time is shown, as a date too.
  const other = '2026-11-16T21:00:00.000Z';
  const later = operationsView(project({ findings: [finding('declined', { disposition: { status: 'declined', by: 'operator', at: other } })] }));
  const shown = byTag(later, 'time').filter(node => node.attributes.datetime === other);
  assert.equal(shown.length, 1);
  assert.doesNotMatch(shown[0].textContent, /ago/);
  // A closed upkeep candidate has no "Status changed" row: its disposition keeps its time, as a date.
  const upkeep = { mode: 'propose', suspensions: [], candidates: [], tasked: [], closed: [candidate('declined', { disposition: { status: 'declined', by: 'operator', at: STATUS_AT } })], followUp: null };
  const candidateTimes = byTag(operationsView(project({ upkeep })), 'time').filter(node => node.attributes.datetime === STATUS_AT);
  assert.equal(candidateTimes.length, 1);
  assert.doesNotMatch(candidateTimes[0].textContent, /ago/);
});
