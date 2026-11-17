// Knowledge upkeep, slice 2 review: the `upkeep.mode` row of the console's Settings tab. It offers
// only the modes this release has, sends the operator's settings.update, and refuses beforehand
// what the project would refuse: turning it on over a task in the reserved namespace, and any
// change while the stored block is not valid. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, byClass, byTag, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import { upkeepMode } from '../starter/factory/core/upkeep-config.mjs';

installDom();
const { projectSettings } = await import('../starter/factory/console/ui/settings.mjs');

const delivery = (extra = {}) => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 }, ...extra });
function setup(t, upkeep = { mode: 'off', docs: { include: ['README.md'] } }) {
  const f = sandbox(t); assert.equal(f.command('config.update', { config: delivery(upkeep === undefined ? {} : { upkeep }), note: 'Delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  // The Policy section as the console renders it from the project's own settings view.
  const render = () => projectSettings({ projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: { revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: JSON.parse(JSON.stringify(settingsView(f.store))) } }, { params: { section: 'policy' } });
  const row = view => byClass(view, 'setting-row').find(node => byTag(node, 'code').some(code => code.textContent === 'upkeep.mode'));
  return { ...f, render, row, stored: () => f.store.meta('config') };
}
// The fake DOM keeps `disabled` as an attribute; a browser reflects it as the property the form reads.
const off = node => node.disabled === true || node.attributes.disabled !== undefined;
const form = row => byTag(row, 'form')[0], submit = row => { const node = descendants(form(row)).find(found => found.tag === 'button' && found.attributes.type === 'submit'); return { node, disabled: off(node) }; };
const reasons = row => byClass(form(row), 'reasons').flatMap(list => list.children.map(item => item.textContent));
// Submit the row's form with a value, and return the command the console sends.
async function send(t, row, value) {
  const old = globalThis.fetch, sent = []; t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ status: 'completed', receipt: { status: 'completed' } }) }; };
  byTag(form(row), 'select')[0].value = value; submit(row).node.disabled = submit(row).disabled;
  for (const handler of form(row).handlers.submit ?? []) await handler({ preventDefault() {} });
  globalThis.fetch = old; return sent;
}

test('Settings shows the upkeep.mode row with the three modes of this release, and sends the operator\'s settings.update', async t => {
  const f = setup(t), view = f.render(), row = f.row(view);
  assert.ok(row, 'the row is in the Policy section');
  assert.deepEqual(byTag(row, 'strong').map(node => node.textContent)[0], 'Knowledge upkeep');
  assert.match(row.textContent, /Only you can turn it up; the orchestrator can turn it down\./); assert.match(row.textContent, /propose: the same, and the docs corrections it keeps are listed in Health; the factory turns waiting ones into a docs follow-up task that runs only after you approve it\./); assert.match(row.textContent, /a model is asked once what it would change, and the answer is counted\. No candidate or task is created/);
  assert.deepEqual(byTag(row, 'option').map(option => option.value), ['off', 'observe', 'propose'], 'no mode this release does not have');
  assert.equal(submit(row).disabled, false); assert.deepEqual(reasons(row), []);
  // It is a setting row like the others, so it stacks to one column at phone width.
  assert.ok(row.classList.includes('setting-row')); assert.match(readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8'), /@media \(max-width: 760px\) \{ \.setting-row \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  // What it sends is what the project accepts from the operator: the change, and the value it was read at.
  const [command] = await send(t, row, 'observe');
  assert.equal(command.actor, 'operator'); assert.equal(command.operation, 'settings.update'); assert.deepEqual(command.payload.changes, { 'upkeep.mode': 'observe' }); assert.deepEqual(command.payload.expected, { 'upkeep.mode': 'off' });
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: command.actor, operation: command.operation, payload: command.payload });
  assert.equal(receipt.status, 'completed', receipt.error); assert.equal(upkeepMode(f.stored()), 'observe');
  // Observing: it can be turned off, and reset, with nothing in the way.
  const on = f.row(f.render()); assert.match(on.textContent, /observe/); assert.equal(submit(on).disabled, false); assert.deepEqual(reasons(on), []);
  assert.ok(descendants(on).some(node => node.tag === 'button' && node.textContent === 'Reset to default' && !off(node)));
});

test('the row refuses to turn upkeep on while the project would: an open task the factory did not make in the reserved namespace', async t => {
  const f = setup(t);
  f.store.put('task', { id: 'Upkeep:legacy', title: 'Fictional task from before the reservation', acceptance: ['Observed'], revision: digest('legacy'), approvedRevision: null, approvalVersion: 1 });
  const row = f.row(f.render());
  assert.equal(submit(row).disabled, true);
  assert.deepEqual(reasons(row), ['observe', 'propose'].map(mode => `It cannot be set to ${mode}: knowledge upkeep cannot be turned on: open task in the reserved upkeep: namespace that the factory did not make: Upkeep:legacy; finish or close it and rename the source namespace before turning upkeep on.`));
  assert.deepEqual(await send(t, row, 'observe'), [], 'nothing is sent');
  // The project refuses the same change, for the same reason.
  const refused = f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }); assert.equal(refused.status, 'rejected'); assert.equal(`It cannot be set to observe: ${refused.error}.`, reasons(row)[0], 'the row gives the project\'s own reason');
  // With the task closed the row offers it again.
  assert.equal(f.command('task.put', { task: { id: 'Upkeep:legacy', title: 'Fictional task from before the reservation', acceptance: ['Observed'], closed: true } }).status, 'completed');
  const free = f.row(f.render()); assert.equal(submit(free).disabled, false); assert.deepEqual(reasons(free), []);
  // The lookup is never a scan, and a read model does not depend on the record layout: with the index
  // unverified the view names no blocker (it reads nothing instead), and the project still refuses.
  f.store.db.exec('DROP INDEX records_open_task_lower_id');
  assert.deepEqual(settingsView(f.store).upkeep, { mode: 'off', problem: null, route: { pinned: false, on: false }, refused: { off: [], observe: [], propose: [], reset: [] } });
  const unverified = f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }); assert.equal(unverified.status, 'rejected'); assert.match(unverified.error, /cannot be turned on: knowledge upkeep cannot read task through its index/);
});

test('with a stored block this release refuses, the row says upkeep is off and why, changes nothing, and shows the text as text', async t => {
  const f = setup(t, undefined), hostile = '<img src=x onerror=alert(1)>';
  // As the release before stored it: a string where a list belongs, and a key no release defines.
  f.store.setMeta('config', { ...f.stored(), upkeep: { mode: 'observe', docs: { include: 'docs/**/*.md' }, [hostile]: 1 } });
  const view = f.render(), row = f.row(view);
  assert.equal(submit(row).disabled, true);
  // No mode makes this block valid, so each is refused with the validator's reason, and the row says what to do.
  assert.equal(reasons(row).length, 3); for (const [index, mode] of ['off', 'observe', 'propose'].entries()) assert.match(reasons(row)[index], new RegExp(`^It cannot be set to ${mode}: upkeep supports only mode, docs, context, capture, budget \\(found <img src=x onerror=alert\\(1\\)>\\)\\.$`));
  assert.match(row.textContent, /The stored upkeep or learnings settings are not valid for this release, so upkeep is off: upkeep supports only .*\. Replace the block with config update \(for example "upkeep": \{"mode": "off"\}\)\./);
  assert.equal(byTag(view, 'img').length, 0, 'the stored text is shown as text, never as markup'); assert.ok(row.textContent.includes(hostile));
  assert.deepEqual(await send(t, row, 'off'), []);
  // The project refuses a change to the mode on that block as well.
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }).status, 'rejected');
  // The reset button is refused for the same reason.
  const reset = descendants(row).filter(node => node.tag === 'button' && node.textContent === 'Reset to default'); assert.equal(reset.length, 1); assert.equal(off(reset[0]), true);
  // Replaced with a valid block, the row works again.
  assert.equal(f.command('config.update', { config: delivery({ upkeep: { mode: 'off' } }), note: 'Replace the block' }).status, 'completed');
  const fixed = f.row(f.render()); assert.equal(submit(fixed).disabled, false); assert.deepEqual(reasons(fixed), []);
  // A project service that predates the setting has no row to act on, and the section still renders.
  const older = JSON.parse(JSON.stringify(settingsView(f.store))); delete older.live['upkeep.mode']; delete older.upkeep;
  const plain = projectSettings({ projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: { revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: older } }, { params: { section: 'policy' } });
  assert.equal(byTag(f.row(plain), 'form').length, 0);
});

test('a stored mode this release does not have is recovered from the row: the guard judges the configuration that would result, not the stored problem', async t => {
  const f = setup(t, undefined);
  // As the release before stored it. The mode is the only thing wrong, so setting a mode this release has makes the block valid.
  f.store.setMeta('config', { ...f.stored(), upkeep: { mode: 'apply', docs: { include: ['README.md'] } } });
  assert.deepEqual(settingsView(f.store).upkeep, { mode: 'off', problem: 'upkeep.mode must be one of off, observe, propose', route: { pinned: false, on: false }, refused: { off: [], observe: [], propose: [], reset: [] } });
  const row = f.row(f.render());
  assert.equal(submit(row).disabled, false, 'Save is offered'); assert.deepEqual(reasons(row), []);
  assert.deepEqual(byTag(row, 'option').map(option => option.value), ['off', 'observe', 'propose']); assert.equal(byTag(form(row), 'select')[0].value, 'off', 'the stored mode is not among the choices, so it is not preselected');
  assert.match(row.textContent, /The stored upkeep or learnings settings are not valid for this release, so upkeep is off: upkeep\.mode must be one of off, observe, propose.*Saving a mode here corrects it\./);
  const reset = descendants(row).filter(node => node.tag === 'button' && node.textContent === 'Reset to default'); assert.equal(reset.length, 1); assert.equal(off(reset[0]), false, 'Reset is offered');
  // What it sends is accepted: the same command the operator could send by hand.
  const [command] = await send(t, row, 'off');
  assert.deepEqual(command.payload.changes, { 'upkeep.mode': 'off' }); assert.deepEqual(command.payload.expected, { 'upkeep.mode': 'apply' });
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: command.actor, operation: command.operation, payload: command.payload });
  assert.equal(receipt.status, 'completed', receipt.error); assert.deepEqual(f.stored().upkeep, { mode: 'off', docs: { include: ['README.md'] } }); assert.equal(settingsView(f.store).upkeep.problem, null);
  // The same recovery by reset, and straight to observe.
  for (const [payload, mode] of [[{ changes: { 'upkeep.mode': null } }, 'off'], [{ changes: { 'upkeep.mode': 'observe' } }, 'observe']]) {
    f.store.setMeta('config', { ...f.stored(), upkeep: { mode: 'apply' } });
    assert.equal(f.command('settings.update', { ...payload, note: 'Recover' }).status, 'completed'); assert.equal(upkeepMode(f.stored()), mode);
  }
  // Each answer follows the result, value by value. Where turning it on is the only thing refused, off stays offered and observe says why.
  f.store.setMeta('config', { ...f.stored(), upkeep: { mode: 'apply' } });
  f.store.put('task', { id: 'upkeep:legacy', title: 'Fictional task from before the reservation', acceptance: ['Observed'], revision: digest('legacy'), approvedRevision: null, approvalVersion: 1 });
  const mixed = f.row(f.render());
  assert.equal(submit(mixed).disabled, false); assert.deepEqual(byTag(mixed, 'option').map(option => option.value), ['off'], 'observe and propose are not offered');
  assert.match(form(mixed).textContent, /It cannot be set to observe: knowledge upkeep cannot be turned on: open task in the reserved upkeep: namespace/); assert.deepEqual(reasons(mixed), []);
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'rejected'); assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }).status, 'completed');
  // A block that is not an object cannot take the setting at all: refused by the project with a plain reason, and so by the row.
  f.store.setMeta('config', { ...f.stored(), upkeep: 'on' });
  const scalar = f.row(f.render()); assert.equal(submit(scalar).disabled, true); assert.match(reasons(scalar)[0], /^It cannot be set to off: upkeep in the stored configuration is not an object, so upkeep\.mode cannot be set in it; replace upkeep with config update\.$/);
  const refused = f.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }); assert.equal(refused.status, 'rejected'); assert.match(refused.error, /^upkeep in the stored configuration is not an object/);
});

// ---- Review Q7: the pinned route is shown with the mode ----
test('Settings shows the route the assessment is pinned to, and that a reviewer change does not move it', async t => {
  const f = setup(t), status = () => byClass(f.row(f.render()), 'help').map(node => node.textContent).find(text => text.startsWith('Assessment model')) ?? null;
  // Off: nothing is pinned and nothing is shown.
  assert.equal(status(), null); assert.deepEqual(settingsView(f.store).upkeep.route, { pinned: false, on: false });
  // Turned on by the operator: the reviewer's route at that moment is pinned and named.
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed');
  const route = settingsView(f.store).upkeep.route; assert.deepEqual({ ...route, pinnedAt: null }, { pinned: true, on: true, source: 'providers.reviewer', provider: 'claude', model: 'm', effort: null, pinnedAt: null, by: 'operator' });
  assert.equal(status(), `Assessment model: claude / m, the reviewer's route as it was when upkeep was turned on on ${route.pinnedAt.slice(0, 10)}. Later changes to the reviewer do not change it; set providers.upkeep to choose another, or turn upkeep off and on to pin the reviewer's route again.`);
  // The reviewer changes: the row still names the pinned route.
  assert.equal(f.command('config.update', { config: { ...f.stored(), providers: { ...f.stored().providers, reviewer: { provider: 'claude', model: 'm-next' } } }, note: 'A new reviewer model' }).status, 'completed');
  assert.match(status(), /^Assessment model: claude \/ m, the reviewer's route as it was/); assert.equal(settingsView(f.store).upkeep.route.model, 'm');
  // providers.upkeep, set by the operator, is the route and is shown as such.
  assert.equal(f.command('config.update', { config: { ...f.stored(), providers: { ...f.stored().providers, upkeep: { provider: 'codex', model: 'm-small', effort: 'low' } } }, note: 'A model for upkeep' }).status, 'completed');
  assert.equal(status(), 'Assessment model: codex / m-small (providers.upkeep). Only you can change it.'); assert.deepEqual({ ...settingsView(f.store).upkeep.route, pinnedAt: null }, { pinned: true, on: true, source: 'providers.upkeep', provider: 'codex', model: 'm-small', effort: 'low', pinnedAt: null, by: 'operator' });
  // A project that observes and has no pin yet (it adopted the release while observing): the row says when it will be pinned.
  f.store.setMeta('config', { ...f.stored(), providers: { ...f.stored().providers, upkeep: undefined } }); f.store.setMeta('upkeepRoute', null);
  assert.equal(status(), 'Assessment model: the route in force is pinned when the next assessment starts.'); assert.deepEqual(settingsView(f.store).upkeep.route, { pinned: false, on: true });
});
