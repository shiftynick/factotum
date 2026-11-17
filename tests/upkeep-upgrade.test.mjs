// Knowledge upkeep, slice 2 review (P2-2): the release before ignored the `upkeep` and `learnings`
// blocks, so a project may hold values this release refuses. Such a project must keep running
// with upkeep off, must never crash a comparison, must be refused by `upgrade apply` before
// anything is touched, and must be recoverable by replacing the block. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandbox } from './helpers.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import { mergeUpgrade, prepareUpgrade, storedConfigProblem } from '../starter/factory/operations/upgrade-apply.mjs';
import { buildRelease } from '../starter/factory/distribution.mjs';
import { compileCatalog, referenceKind, referenceWorkflow } from '../starter/factory/core/catalog.mjs';
import { REFERENCE_KINDS, definitionKind } from '../starter/factory/core/workflow-kinds.mjs';
import { writeUpkeepReceiptInTransaction } from '../starter/factory/operations/upkeep-runs.mjs';
import { delegatedUpkeepChanges, learningsSettings, upkeepAuthority, upkeepAuthorityChanges, upkeepBlockProblem, upkeepMode, upkeepSettings } from '../starter/factory/core/upkeep-config.mjs';

const delivery = (extra = {}) => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 }, ...extra });
const CATALOG = { definitions: { change: { reference: 'change.standard' }, docs: { reference: 'change.document' }, chore: { reference: 'task.orchestrator' }, errand: { reference: 'task.operator' } }, selection: { default: 'change' } };
const VALID = { upkeep: { mode: 'observe', docs: { include: ['README.md', 'docs/**/*.md'] } } }, RECOVERED = { upkeep: { mode: 'off' } };
// Blocks the release before accepted (it read neither) and this one refuses.
const LEGACY = {
  'a string where the include list belongs, mode off': { upkeep: { mode: 'off', docs: { include: 'docs/**/*.md' } } },
  'an object where the map belongs': { upkeep: { mode: 'off', docs: { map: {} } } },
  'the same, with the mode observe': { upkeep: { mode: 'observe', docs: { include: ['README.md'], map: {} } } },
  'a map of rows without paths': { upkeep: { mode: 'observe', docs: { map: [{ docs: 'docs/**' }, null, 7] } } },
  'a mode this release does not have': { upkeep: { mode: 'apply', docs: { include: ['README.md'] } } },
  'a limit above its ceiling': { upkeep: { mode: 'observe', budget: { maxTasksPerDay: 50 } } },
  'a block that is not an object': { upkeep: 'on' },
  'a null block': { upkeep: null },
  'a docs part that is a list': { upkeep: { mode: 'observe', docs: ['README.md'] } },
  'an unknown key': { upkeep: { mode: 'observe', approval: 'configuration' } },
  // A selector the catalog resolves to a task workflow, through the reference alone (no `kind` written).
  'a workflow selector that names a task workflow by reference': { workflows: CATALOG, upkeep: { mode: 'observe', docs: { include: ['README.md'], workflow: 'chore' } } },
  'a workflow selector with no catalog': { upkeep: { mode: 'observe', docs: { workflow: 'docs' } } },
  'a learnings block that is a string': { learnings: 'docs/learnings' },
  'a learnings directory that leaves the repository': { upkeep: { mode: 'observe' }, learnings: { dir: '../outside', maxEntries: 400 } },
};

// A release built from this checkout: upgrade apply loads the validator from the release being
// adopted, so the regression below is judged by this release's own files, as an adopter's would be.
const releaseRoot = mkdtempSync(join(tmpdir(), 'fct-upkeep-release-')); test.after(() => rmSync(releaseRoot, { recursive: true, force: true }));
const builtRelease = buildRelease({ sourceDir: fileURLToPath(new URL('../starter', import.meta.url)), outputDir: join(releaseRoot, 'release'), version: '0.2.0-dev.20261116.1', allowWorkingTree: true });
const thisRelease = () => ({ dir: join(releaseRoot, 'release'), digest: builtRelease.manifestDigest, factory: join(releaseRoot, 'release', 'starter', 'factory') });
const BASELINE = '283ba91';
async function baselineRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fct-upkeep-base-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  try { execFileSync('sh', ['-c', `git archive ${BASELINE} starter | tar -x -C "$1"`, 'sh', dir], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' }); }
  catch (error) { return { skip: `the baseline runtime ${BASELINE} is not in this checkout's git history (${String(error.stderr || error.message).trim().split('\n')[0]})` }; }
  const load = path => import(pathToFileURL(join(dir, 'starter/factory', path)).href);
  return { Store: (await load('core/store.mjs')).Store, executeCommand: (await load('core/project.mjs')).executeCommand };
}
// A delivery project whose stored configuration holds a legacy block: stored by the release before
// through its own config.update when that runtime is available, otherwise written as it stored it.
function legacyProject(t, block, base) {
  const f = sandbox(t), config = delivery(block);
  if (base && !base.skip) {
    const store = new base.Store(f.stateDir);
    try { const receipt = base.executeCommand(store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation: 'config.update', payload: { config, note: 'Delivery, with a block the release ignores' } }); assert.equal(receipt.status, 'completed', `the release before accepts it: ${receipt.error}`); }
    finally { store.close(); }
  } else { assert.equal(f.command('config.update', { config: delivery(), note: 'Delivery' }).status, 'completed'); f.store.setMeta('config', config); }
  assert.deepEqual(f.store.meta('config').upkeep, config.upkeep); assert.deepEqual(f.store.meta('config').learnings, config.learnings);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  const delegated = (operation, payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation, payload: { note: 'Operator asked', ...payload }, onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction' } });
  return { ...f, delegated, stored: () => f.store.meta('config') };
}

test('a stored block this release refuses is read without failing: upkeep is off, every unreadable field is at its default, and the authority value keeps what is stored', () => {
  const defaults = upkeepSettings({}), learnt = learningsSettings({});
  for (const [name, block] of Object.entries(LEGACY)) {
    const config = delivery(block);
    assert.ok(upkeepBlockProblem(config), name); assert.throws(() => validateConfig(config), /upkeep|learnings/, name);
    assert.equal(upkeepMode(config), 'off', `${name}: the factory does less, never more`);
    const settings = upkeepSettings(config);
    assert.deepEqual(Object.keys(settings), Object.keys(defaults)); for (const list of [settings.docs.include, settings.docs.exclude, settings.docs.map]) assert.ok(Array.isArray(list), name);
    for (const part of ['docs', 'context', 'capture', 'budget']) for (const [key, value] of Object.entries(settings[part])) if (typeof defaults[part][key] === 'number') assert.ok(Number.isSafeInteger(value) && value <= defaults[part][key], `${name}: ${part}.${key} is never above its ceiling`);
    assert.deepEqual(Object.keys(learningsSettings(config)), Object.keys(learnt)); assert.ok(learningsSettings(config).dir === null || typeof learningsSettings(config).dir === 'string');
    // The comparison never fails, in either direction, against a valid block, an absent one and itself.
    assert.deepEqual(upkeepAuthorityChanges(config, config).changed, [], name);
    for (const other of [delivery(VALID), delivery(RECOVERED), delivery()]) {
      const away = upkeepAuthorityChanges(config, other), back = upkeepAuthorityChanges(other, config);
      assert.ok(away.changed.length > 0 && back.changed.length > 0, `${name}: a change away from it, or to it, is a change of authority`);
      assert.ok(delegatedUpkeepChanges(config, other).length > 0, `${name}: so a delegate may not make it`);
      // Leaving a mode this release cannot read is never "turning the mode down", the one thing a delegate may do.
      if (!['off', 'observe', 'propose'].includes(block.upkeep?.mode) && block.upkeep !== undefined && !(typeof block.upkeep === 'object' && block.upkeep && block.upkeep.mode === undefined)) assert.equal(away.turnedDown, false, name);
    }
    // Correcting it into a block that observes is turning upkeep on, whatever mode the bad block named.
    assert.equal(upkeepAuthorityChanges(config, delivery(VALID)).turnedUp, true, name);
    assert.equal(upkeepAuthorityChanges(config, delivery(RECOVERED)).turnedUp, false, name);
  }
  // What is stored is kept as a digest, so two different unreadable values differ and equal ones do not.
  const a = upkeepAuthority(delivery({ upkeep: { docs: { map: {} } } })), b = upkeepAuthority(delivery({ upkeep: { docs: { map: { x: 1 } } } }));
  assert.deepEqual(Object.keys(a['upkeep.docs.map']), ['unreadable']); assert.notDeepEqual(a['upkeep.docs.map'], b['upkeep.docs.map']); assert.deepEqual(a['upkeep.docs.include'], []);
  assert.deepEqual(upkeepAuthority(delivery({ upkeep: { docs: { map: {} } } }))['upkeep.docs.map'], a['upkeep.docs.map']);
  // A valid field beside an unreadable one is still read as itself.
  assert.deepEqual(upkeepAuthority(delivery({ upkeep: { mode: 'observe', docs: { include: ['b.md', 'a.md'], map: {} } } }))['upkeep.docs.include'], ['a.md', 'b.md']);
});

test('upgrade regression: a project the release before commissioned with such a block keeps running with upkeep off, is refused by upgrade apply before anything is touched, and recovers by replacing the block', async t => {
  const base = await baselineRuntime(t); if (base.skip) t.diagnostic(`${base.skip}; the stored configurations are written directly`);
  for (const [name, block] of Object.entries(LEGACY)) {
    const f = legacyProject(t, block, base);
    // The running project: nothing fails, and nothing of upkeep happens.
    await operationalTick(f.store); settingsView(f.store);
    assert.equal(f.store.tx(() => writeUpkeepReceiptInTransaction(f.store, { id: 'flow-x', kind: 'change', taskId: 'x', taskSnapshot: {}, results: {} }, { sha: 'a'.repeat(40) })), null, `${name}: no receipt`);
    assert.equal(f.store.count('upkeepRun'), 0);
    // Recommissioning what is stored (config update --current) is refused, with a message that names the setting.
    const current = f.command('config.update', { config: f.stored(), note: 'Recommission after adopting a release' });
    assert.equal(current.status, 'rejected', name); assert.match(current.error, /^(upkeep|learnings)/, name); assert.doesNotMatch(current.error, /is not a function|Cannot read|undefined/, name);
    // upgrade apply validates with the release being adopted, loaded from that release: preparing and
    // merging refuse first, naming the fix. (--activate does the same from the remote target: tests/upgrade-apply.test.mjs.)
    const worktree = join(f.base, 'review'), release = thisRelease(), options = { root: f.root, stateDir: f.stateDir, releaseDir: release.dir, expectedDigest: release.digest, branch: 'factotum-update', worktreeDir: worktree };
    for (const [form, attempt] of [['prepare', () => prepareUpgrade(options)], ['merge', () => mergeUpgrade({ ...options, backupDir: join(f.base, 'backup') })]]) {
      await assert.rejects(async () => attempt(), error => { assert.match(error.message, /stored configuration is not valid for the release being adopted \(0\.2\.0-dev\.20261116\.1\), so the upgrade would leave it unable to recommission: (upkeep|learnings)/, `${name}, ${form}`); assert.match(error.message, /Nothing was changed\. Correct it first, with the release the project runs now/); assert.match(error.message, /replace it with a valid block, for example "upkeep": \{"mode": "off"\}, or remove it/); return true; });
    }
    assert.equal(existsSync(worktree), false); assert.equal(existsSync(join(f.base, 'backup')), false); assert.equal(execFileSync('git', ['branch', '--list', 'factotum-update'], { cwd: f.root, encoding: 'utf8' }).trim(), '');
    // A delegate cannot be the one to change it: it is a change of authority, refused as one.
    for (const payload of [{ config: delivery(VALID) }, { config: delivery(RECOVERED) }, { config: delivery(RECOVERED), replaceLive: true }]) { const refused = f.delegated('config.update', payload); assert.equal(refused.status, 'rejected', name); assert.match(refused.error, /cannot change knowledge upkeep settings \(.*\); they are authority/, name); }
    // The live setting: a delegate cannot use it on such a block (the result is still not valid, or the
    // mode it leaves is one this release cannot read, so it is not "turning it down").
    const viaSetting = f.delegated('settings.update', { changes: { 'upkeep.mode': 'off' } }); assert.equal(viaSetting.status, 'rejected', name); assert.doesNotMatch(viaSetting.error, /is not a function|Cannot read/, name);
    assert.deepEqual(f.stored().upkeep, block.upkeep, `${name}: nothing was stored by a refused command`);
    // Recovery, by the operator: replace the block with a valid off block. Then everything works again.
    const recovered = f.command('config.update', { config: delivery(RECOVERED), note: 'Replace the block the last release ignored' });
    assert.equal(recovered.status, 'completed', `${name}: ${recovered.error}`); assert.equal(storedConfigProblem(f.stored(), release.factory), null);
    assert.equal(f.command('config.update', { config: f.stored(), note: 'Recommission' }).status, 'completed');
    await assert.rejects(async () => prepareUpgrade(options), error => { assert.doesNotMatch(error.message, /stored configuration/); return true; }, 'the preflight passes; the fixture project was never adopted, so there is nothing to update');
    assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed'); assert.equal(upkeepMode(f.stored()), 'observe');
  }
  // The operator's settings.update on such a block is accepted exactly when its result is a valid
  // block (the mode was the only thing wrong), and refused with the validator's reason otherwise.
  const onlyMode = legacyProject(t, LEGACY['a mode this release does not have'], base);
  assert.equal(onlyMode.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }).status, 'completed'); assert.equal(storedConfigProblem(onlyMode.stored(), thisRelease().factory), null);
  const more = legacyProject(t, LEGACY['an object where the map belongs'], base), refused = more.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /^upkeep\.docs\.map must be a list/);
});

test('an operator update from a stored block the release ignored straight to a valid observing one is accepted, with and without replaceLive', async t => {
  const base = await baselineRuntime(t);
  for (const replaceLive of [false, true]) for (const block of [LEGACY['an object where the map belongs'], LEGACY['the same, with the mode observe'], LEGACY['a string where the include list belongs, mode off'], LEGACY['a block that is not an object']]) {
    const f = legacyProject(t, block, base);
    const updated = f.command('config.update', { config: delivery(VALID), note: 'A valid block that observes', ...(replaceLive ? { replaceLive: true } : {}) });
    assert.equal(updated.status, 'completed', `${JSON.stringify(block)}${replaceLive ? ' (replaceLive)' : ''}: ${updated.error}`);
    assert.equal(upkeepMode(f.stored()), 'observe'); assert.deepEqual(f.stored().upkeep, VALID.upkeep);
  }
  // Turning it on this way is still refused over an open task in the reserved namespace.
  const f = legacyProject(t, LEGACY['the same, with the mode observe'], base);
  f.store.put('task', { id: 'upkeep:legacy', title: 'Fictional task from before the reservation', acceptance: ['Observed'], revision: 'r', approvedRevision: null, approvalVersion: 1 });
  const refused = f.command('config.update', { config: delivery(VALID), note: 'On' }); assert.equal(refused.status, 'rejected'); assert.match(refused.error, /knowledge upkeep cannot be turned on: open task in the reserved upkeep: namespace/);
  assert.equal(f.command('config.update', { config: delivery(RECOVERED), note: 'Off is always possible' }).status, 'completed');
});

test('the preflight is the release\'s whole validator: any stored configuration it refuses stops the upgrade, and a valid one passes', () => {
  const factory = thisRelease().factory;
  for (const config of [delivery(), delivery(VALID), {}, undefined]) assert.equal(storedConfigProblem(config, factory), null);
  // Not only upkeep: the reserved namespace of slice 1 is refused before the upgrade as well, without the upkeep hint.
  const reserved = storedConfigProblem(delivery({ sourceSync: { type: 'command', namespace: 'upkeep:', command: ['true'] } }), factory);
  assert.match(reserved, /not valid for the release being adopted/); assert.doesNotMatch(reserved, /replace it with a valid block/);
  assert.match(storedConfigProblem(delivery({ learnings: 'x' }), factory), /Earlier releases ignored the learnings block/);
});

test('a workflow selector is judged as the catalog compiles it: a selector that names a task workflow by reference reads as off and writes no receipt', async t => {
  // The review's repro: nothing in the block says `kind`; only the reference makes `chore` a task workflow.
  const config = delivery({ workflows: CATALOG, upkeep: { mode: 'observe', docs: { workflow: 'chore' } } });
  assert.throws(() => validateConfig(config), /upkeep\.docs\.workflow names "chore", a workflow of kind task/);
  assert.match(upkeepBlockProblem(config), /upkeep\.docs\.workflow names "chore", a workflow of kind task/); assert.equal(upkeepMode(config), 'off');
  const f = legacyProject(t, { workflows: CATALOG, upkeep: config.upkeep }, await baselineRuntime(t));
  assert.equal(upkeepMode(f.stored()), 'off');
  assert.equal(f.store.tx(() => writeUpkeepReceiptInTransaction(f.store, { id: 'flow-merged', kind: 'change', taskId: 'x', taskSnapshot: {}, results: {} }, { sha: 'a'.repeat(40) })), null, 'a merged change creates no pending receipt');
  assert.equal(f.store.count('upkeepRun'), 0); assert.equal(settingsView(f.store).upkeep.mode, 'off');
  // Every selector, for every shape of definition: the block's problem is exactly what the full validator says.
  for (const [name, expected] of [['change', null], ['docs', null], ['chore', /kind task/], ['errand', /kind task/], ['missing', /not a workflow in the catalog/]]) {
    for (const definitions of [CATALOG.definitions, { ...CATALOG.definitions, chore: { reference: 'task.orchestrator', kind: 'task' } }]) {
      const candidate = delivery({ workflows: { ...CATALOG, definitions }, upkeep: { mode: 'observe', docs: { workflow: name } } });
      let full = null; try { validateConfig(candidate); } catch (error) { full = error.message; }
      assert.equal(upkeepBlockProblem(candidate), full, `${name}: the two answers are one`); if (expected) assert.match(full, expected); else assert.equal(full, null, name);
      assert.equal(upkeepMode(candidate), expected ? 'off' : 'observe', name);
    }
  }
  // One resolution: the kinds the validator uses are the ones the catalog compiles, for every reference.
  const compiled = compileCatalog(delivery({ workflows: CATALOG }), f.root);
  for (const [name, definition] of Object.entries(CATALOG.definitions)) { assert.equal(compiled.workflows[name].kind, definitionKind(definition), name); assert.equal(referenceKind(definition.reference), REFERENCE_KINDS[definition.reference]); assert.ok(referenceWorkflow(definition.reference, delivery())); }
  assert.deepEqual(Object.keys(REFERENCE_KINDS).sort(), ['change.document', 'change.standard', 'task.operator', 'task.orchestrator']);
  assert.equal(definitionKind({ reference: 'task.operator', kind: 'task' }), 'task'); assert.equal(definitionKind({ path: 'project/workflows/custom.json' }), 'change'); assert.equal(definitionKind({ path: 'x.json', kind: 'document' }), 'document');
});
