// dev.89: the console findings of the dev.88 readiness re-test. M5: a click on blank space inside the
// flow window closed it. M9: Health's finding detail showed raw ISO times, and the finding forms had
// no confirmation. Fictional fixtures; see docs/changes/dev89-m-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, byTag, descendants } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 1200;
const { backdropClick } = await import('../starter/factory/console/ui/dom.mjs');
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const { recordDetail } = await import('../starter/factory/console/ui/records.mjs');
const read = path => readFileSync(new URL(`../starter/factory/console/${path}`, import.meta.url), 'utf8');

// ---- M5 -----------------------------------------------------------------------------------------
test('M5: only a click outside the flow window closes it; a click on its own padding, or one from the keyboard, does not', () => {
  // The trial's geometry: the desktop window and the phone window, each clicked on its own padding at (162,110) and (30,110).
  for (const box of [{ left: 150, right: 1290, top: 40, bottom: 860 }, { left: 16, right: 304, top: 16, bottom: 620 }]) {
    const dialog = { getBoundingClientRect: () => box }, click = (x, y, target = dialog) => backdropClick(dialog, { target, clientX: x, clientY: y });
    assert.equal(click(box.left + 12, 110), false, 'the window\'s own blank padding');
    assert.equal(click(box.left - 5, 110), true, 'the backdrop, left of the window');
    assert.equal(click(box.left + 20, box.bottom + 10), true, 'the backdrop, below it');
    assert.equal(click(box.left + 20, 110, { tag: 'p' }), false, 'a click on content inside');
    assert.equal(click(0, 0), false, 'a click from the keyboard has no position');
  }
  // The flow window uses it, and nothing else closes it on a click.
  const ui = read('ui.mjs');
  assert.match(ui, /detailDialog\.addEventListener\('click', event => \{ if \(backdropClick\(detailDialog, event\)\) detailDialog\.close\(\); \}\);/);
  assert.doesNotMatch(ui, /event\.target === detailDialog/);
});

// ---- M9 -----------------------------------------------------------------------------------------
const AT = '2026-11-16T19:59:41.143Z', STATUS_AT = '2026-11-16T20:39:45.346Z';
const finding = (status, extra = {}) => ({ id: `audit:fictional-${status}`, source: 'audit', title: `Fictional ${status} finding`, status, version: 2, severity: 'medium', evidence: 'fictional.mjs:12', observations: 1, createdAt: AT, statusAt: STATUS_AT, ...extra });
function project(findings) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], findings,
    settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } };
}

test('M9: a finding\'s detail shows its times as time elements with the UTC value in the tooltip, never as raw ISO text', () => {
  const body = recordDetail('finding', finding('declined'), project([]));
  const times = byTag(body, 'time').filter(node => !descendants(node).some(n => n.tag === 'details'));
  for (const iso of [AT, STATUS_AT]) assert.ok(times.some(node => node.attributes.datetime === iso && node.attributes.title === `${iso} (UTC as recorded)`), iso);
  const visible = [...byTag(body, 'dl')].map(node => node.textContent).join(' ');
  assert.ok(!visible.includes(AT) && !visible.includes(STATUS_AT), 'no raw ISO value outside the collapsed raw record');
  assert.ok(!/createdAt|statusAt/.test(visible), 'no raw field names');
  // Health's finding card: the same, with its disposition time.
  const card = operationsView(project([finding('unapproved'), finding('declined', { disposition: { status: 'declined', reason: 'unnecessary', by: 'operator', at: STATUS_AT } })]));
  const shown = byTag(card, 'dl').map(node => node.textContent).join(' ');
  assert.ok(!shown.includes(AT) && !shown.includes(STATUS_AT), 'no raw ISO value in the cards');
  assert.ok(byTag(card, 'time').some(node => node.attributes.datetime === STATUS_AT && node.attributes.title === `${STATUS_AT} (UTC as recorded)`));
  // Any other kind without its own rows: ISO strings are time elements too.
  const generic = recordDetail('somethingElse', { id: 'x', recordedAt: AT }, project([]));
  assert.ok(byTag(generic, 'time').some(node => node.attributes.datetime === AT));
});

test('M9: Decline, Dealt with another way and Reopen ask for confirmation first, like the other console commands; a refusal sends nothing', async () => {
  const asked = [], sent = [];
  globalThis.window.confirm = text => { asked.push(text); return false; };
  globalThis.fetch = async (...args) => { sent.push(args); throw new Error('nothing may be sent'); };
  const view = operationsView(project([finding('unapproved'), finding('tasked', { taskId: 'task-1' }), finding('declined')]));
  const forms = byTag(view, 'form').filter(form => /^(Decline|Record as resolved elsewhere|Reopen) — /.test(form.attributes['aria-label'] ?? ''));
  assert.equal(forms.length, 5, forms.map(form => form.attributes['aria-label']).join(', '));
  for (const form of forms) for (const handler of form.handlers.submit ?? []) await handler({ preventDefault() {} });
  // dev.90 (N3) names the finding and its version in each question: tests/dev90-console.test.mjs has the exact texts.
  assert.deepEqual(asked.map(text => text.split(' ')[0]).sort(), ['Decline', 'Decline', 'Record', 'Record', 'Reopen']);
  assert.ok(asked.every(text => text.endsWith('Target: Fictional project')));
  assert.deepEqual(sent, []);
});

test('M1: History names live setting changes, so a live change an upgrade lost can be found there', async () => {
  const { eventLabel, eventDetail } = await import('../starter/factory/console/ui/records.mjs');
  assert.equal(eventLabel('settings.updated'), 'Settings updated');
  assert.equal(eventDetail({ type: 'settings.updated', payload: { changes: { 'upkeep.mode': 'observe', 'notifications.handoffAfterDeliveries': 80 }, by: 'operator', note: 'On' } }), 'note: On · upkeep.mode = "observe", notifications.handoffAfterDeliveries = 80, by the operator');
  assert.equal(eventLabel('config.live-settings-changed'), 'Live settings changed by a configuration update');
  assert.equal(eventDetail({ type: 'config.live-settings-changed', payload: { settings: ['upkeep.mode'], details: [{ setting: 'upkeep.mode', from: 'observe', to: 'off' }] } }), 'upkeep.mode: "observe" to "off"');
  assert.equal(eventDetail({ type: 'config.kept-live-settings', payload: { settings: ['policy.autoQueue'] } }), 'policy.autoQueue');
});
