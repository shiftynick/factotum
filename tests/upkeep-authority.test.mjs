// Knowledge upkeep, slice 2: the settings and their authority (design 9.2, 12, 13.1). The upkeep
// authority value is protected from a delegated writer on both schemas, by both configuration
// commands, with one exception: turning the mode down. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { referenceWorkflow } from '../starter/factory/core/catalog.mjs';
import { authorityPolicy, authorityPolicyChanges, UPKEEP_AUTHORITY } from '../starter/factory/core/authority-policy.mjs';
import { applyAuthorityMigration } from '../starter/factory/operations/authority-migration.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import { doctor } from '../starter/factory/workflows/commission.mjs';
import { LEARNINGS_DEFAULTS, UPKEEP_DEFAULTS, UPKEEP_MODES, delegatedUpkeepChanges, upkeepAuthority, upkeepAuthorityChanges, upkeepMode, upkeepOn, upkeepSettings } from '../starter/factory/core/upkeep-config.mjs';

const BLOCK = { mode: 'observe', docs: { include: ['README.md', 'docs/**/*.md'], exclude: ['docs/changes/**'], map: [{ docs: 'docs/api/**', paths: ['src/api/**'] }] } };
const base = (extra = {}) => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 }, upkeep: structuredClone(BLOCK), learnings: { dir: 'docs/learnings' }, ...extra });
// A commissioned delivery project with upkeep observing, on schema 1 or migrated to schema 2.
async function setup(t, { schema = 1, config = base() } = {}) {
  const f = sandbox(t);
  if (schema === 2) await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'pre-migration-backup') });
  const applied = f.command('config.update', { config, note: 'Delivery with upkeep observing' }); assert.equal(applied.status, 'completed', applied.error);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  assert.equal(f.store.meta('schemaVersion'), schema);
  const delegated = (operation, payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation, payload: { note: 'Operator asked', ...payload }, onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction' } });
  return { ...f, delegated, stored: () => f.store.meta('config') };
}
const without = (config, path) => { const next = structuredClone(config); let at = next; const parts = path.split('.'); for (const part of parts.slice(0, -1)) at = at[part]; delete at[parts.at(-1)]; return next; };
const set = (config, path, value) => { const next = structuredClone(config); let at = next; const parts = path.split('.'); for (const part of parts.slice(0, -1)) at = at[part] ??= {}; at[parts.at(-1)] = value; return next; };

test('the blocks: defaults, bounds and unknown keys; absent means off; propose is a mode of this release (slice 5 part B)', () => {
  assert.deepEqual(UPKEEP_MODES, ['off', 'observe', 'propose']);
  assert.equal(upkeepMode({}), 'off'); assert.equal(upkeepOn({}), false); assert.equal(upkeepMode({ upkeep: {} }), 'off'); assert.equal(upkeepMode({ upkeep: { mode: 'observe' } }), 'observe');
  // A stored value this release would refuse reads as off: the factory does less, never more.
  assert.equal(upkeepMode({ upkeep: { mode: 'propose' } }), 'propose'); assert.equal(upkeepMode({ upkeep: { mode: 'apply' } }), 'off'); assert.equal(upkeepMode({ upkeep: 'on' }), 'off');
  assert.deepEqual(upkeepSettings({}), { mode: 'off', docs: { include: [], exclude: [], map: [], maxFiles: 3, maxChangedLines: 40, maxWaiting: 10, workflow: null }, context: { maxOpen: 10, qualifiedProviders: [] }, capture: { maxOpen: 10 }, budget: { maxInputChars: 40000, maxTurns: 6, timeoutMs: 300000, maxModelRunsPerDay: 30, maxTasksPerDay: 2, maxTasksPerWeek: 6, maxFlowInvocations: 8, maxOpenTasks: 12, maxQueueAgeMs: 86400000 } });
  assert.deepEqual({ ...LEARNINGS_DEFAULTS }, { dir: null, maxSelected: 5, maxChars: 6000, maxEntries: 40 }); assert.equal(UPKEEP_DEFAULTS.mode, 'off');
  const ok = upkeep => validateConfig(base({ upkeep })), bad = (upkeep, pattern) => assert.throws(() => ok(upkeep), pattern, JSON.stringify(upkeep));
  ok({}); ok({ mode: 'off' }); ok(BLOCK); ok({ mode: 'observe', budget: { maxQueueAgeMs: 3600000, maxModelRunsPerDay: 0 }, context: { maxOpen: 0 }, capture: { maxOpen: 3 }, docs: { maxFiles: 1, maxChangedLines: 10, maxWaiting: 0 } });
  ok({ mode: 'propose', docs: { include: ['README.md'] } }); bad({ mode: 'apply' }, /upkeep\.mode must be one of off, observe, propose$/); bad({ mode: 'on' }, /upkeep\.mode must be one of off, observe, propose/);
  bad({ mode: 'observe', approve: 'auto' }, /upkeep supports only/); bad({ docs: { include: ['README.md'], approval: 'configuration' } }, /upkeep\.docs supports only/); bad({ budget: { maxSpendMicros: 1 } }, /upkeep\.budget supports only/);
  // Every limit may be lowered; none may be raised above the value the design settled.
  for (const [path, over] of [['docs.maxFiles', 4], ['docs.maxChangedLines', 41], ['docs.maxWaiting', 11], ['context.maxOpen', 11], ['capture.maxOpen', 11], ['budget.maxModelRunsPerDay', 31], ['budget.maxTasksPerDay', 3], ['budget.maxTasksPerWeek', 7], ['budget.maxFlowInvocations', 9], ['budget.maxOpenTasks', 13], ['budget.maxQueueAgeMs', 86400001], ['budget.maxInputChars', 40001], ['budget.maxTurns', 7], ['budget.timeoutMs', 300001]]) {
    const [part, name] = path.split('.'); bad({ [part]: { [name]: over } }, new RegExp(`upkeep\\.${part}\\.${name} must be a whole number`)); bad({ [part]: { [name]: -1 } }, /must be a whole number/); bad({ [part]: { [name]: '3' } }, /must be a whole number/);
  }
  for (const include of [['/etc/passwd'], ['../outside.md'], ['docs/../../x.md'], [''], 'README.md', ['a.md', 'a.md'], [7]]) bad({ docs: { include } }, /upkeep\.docs\.include must be a list/);
  bad({ docs: { map: [{ docs: 'docs/**', paths: [] }] } }, /upkeep\.docs\.map/); bad({ docs: { map: [{ docs: 'docs/**', paths: ['src/**'], workflow: 'x' }] } }, /upkeep\.docs\.map/);
  // 7.3: an explicit workflow must be a catalog definition that delivers a change.
  bad({ docs: { workflow: 'docs' } }, /needs a workflow catalog/);
  const catalog = { definitions: { change: { reference: 'change.standard' }, docs: { reference: 'change.document' }, chore: { reference: 'task.orchestrator' } }, selection: { default: 'change' } };
  validateConfig(base({ workflows: catalog, upkeep: { docs: { workflow: 'docs' } } }));
  assert.throws(() => validateConfig(base({ workflows: catalog, upkeep: { docs: { workflow: 'missing' } } })), /not a workflow in the catalog/);
  assert.throws(() => validateConfig(base({ workflows: catalog, upkeep: { docs: { workflow: 'chore' } } })), /a workflow of kind task/);
  for (const learnings of [{ dir: '/abs' }, { dir: 'docs/../x' }, { dir: 'docs/*' }, { maxEntries: 41 }, { maxChars: 6001 }, { maxSelected: 6 }, { retire: true }]) assert.throws(() => validateConfig(base({ learnings })), /learnings/, JSON.stringify(learnings));
  // A rehearsal configuration cannot carry an invalid block either.
  assert.throws(() => validateConfig({ upkeep: { mode: 'apply' } }), /must be one of/);
});

test('graph digests are identical with the upkeep and learnings blocks present and absent, in any mode', () => {
  const template = JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
  const digests = config => Object.fromEntries(['change.standard', 'change.document', 'task.orchestrator', 'task.operator'].map(reference => [reference, digest(referenceWorkflow(reference, validateConfig(config)))]));
  const absent = digests(without(without(template, 'upkeep'), 'learnings'));
  for (const [name, upkeep] of Object.entries({ 'mode off': { mode: 'off' }, 'observing': BLOCK, 'every setting': { mode: 'observe', docs: { ...BLOCK.docs, maxFiles: 2, maxChangedLines: 20, maxWaiting: 5 }, context: { maxOpen: 5 }, capture: { maxOpen: 5 }, budget: { maxInputChars: 20000, maxTurns: 3, timeoutMs: 60000, maxModelRunsPerDay: 10, maxTasksPerDay: 1, maxTasksPerWeek: 3, maxFlowInvocations: 4, maxOpenTasks: 6, maxQueueAgeMs: 3600000 } } })) {
    assert.deepEqual(digests({ ...template, upkeep, learnings: { dir: 'docs/learnings', maxSelected: 3, maxChars: 3000, maxEntries: 20 } }), absent, name);
    // With variants of the graph too: fast checks and no planning.
    const variant = config => ({ ...config, policy: { ...config.policy, planning: false } });
    assert.deepEqual(digests(variant({ ...template, upkeep })), digests(variant(without(without(template, 'upkeep'), 'learnings'))), `${name}, no planning`);
  }
  // The starter template carries the block, off.
  assert.equal(template.upkeep.mode, 'off'); assert.equal(upkeepOn(validateConfig(template)), false);
  // The configuration digest does change: turning the feature on in the file is a configuration change.
  assert.notEqual(digest(validateConfig({ ...template, upkeep: BLOCK })), digest(validateConfig(without(template, 'upkeep'))));
});

test('the authority value: every field of 9.2 with defaults applied, insensitive to list order, and what a change is', () => {
  const value = upkeepAuthority(base());
  assert.deepEqual(Object.keys(value), ['upkeep.mode', 'upkeep.docs.include', 'upkeep.docs.exclude', 'upkeep.docs.map', 'upkeep.docs.maxFiles', 'upkeep.docs.maxChangedLines', 'upkeep.docs.maxWaiting', 'upkeep.docs.workflow', 'upkeep.context.maxOpen', 'upkeep.capture.maxOpen', 'upkeep.budget.maxInputChars', 'upkeep.budget.maxTurns', 'upkeep.budget.timeoutMs', 'upkeep.budget.maxModelRunsPerDay', 'upkeep.budget.maxTasksPerDay', 'upkeep.budget.maxTasksPerWeek', 'upkeep.budget.maxFlowInvocations', 'upkeep.budget.maxOpenTasks', 'upkeep.budget.maxQueueAgeMs', 'upkeep.context.qualifiedProviders', 'providers.upkeep', 'stepModels.maintenance/knowledge.upkeep', 'learnings.dir', 'learnings.maxSelected', 'learnings.maxChars', 'learnings.maxEntries', 'upkeep (stored block)', 'learnings (stored block)']);
  assert.deepEqual([value['upkeep (stored block)'], value['learnings (stored block)']], [null, null], 'null for blocks this release accepts');
  // Defaults are part of the value: writing a default out, or dropping a key that held it, changes nothing.
  assert.deepEqual(upkeepAuthorityChanges(base(), set(base(), 'upkeep.budget.maxTasksPerDay', 2)).changed, []);
  assert.deepEqual(upkeepAuthorityChanges(base(), set(base(), 'upkeep.docs.include', ['docs/**/*.md', 'README.md'])).changed, [], 'list order is not a change');
  assert.deepEqual(upkeepAuthorityChanges({}, { upkeep: { mode: 'off' }, learnings: {} }).changed, []);
  // Dropping a key that widens back to the default is a change.
  assert.deepEqual(upkeepAuthorityChanges(set(base(), 'upkeep.budget.maxTasksPerDay', 1), base()).changed, ['upkeep.budget.maxTasksPerDay']);
  assert.deepEqual(upkeepAuthorityChanges(base(), without(base(), 'upkeep')), { changed: ['upkeep.mode', 'upkeep.docs.include', 'upkeep.docs.exclude', 'upkeep.docs.map'], turnedDown: true, turnedUp: false });
  assert.deepEqual(delegatedUpkeepChanges(base(), set(base(), 'upkeep.mode', 'off')), [], 'turning the mode down is the one exception');
  assert.deepEqual(delegatedUpkeepChanges(set(base(), 'upkeep.mode', 'off'), base()), ['upkeep.mode'], 'turning it up is not');
  assert.deepEqual(delegatedUpkeepChanges(base(), without(base(), 'upkeep')), ['upkeep.docs.include', 'upkeep.docs.exclude', 'upkeep.docs.map'], 'turning it down does not cover another field changed with it');
  // Schema 2: the value is part of the authority-bearing policy, with the same exception.
  assert.deepEqual(authorityPolicy(base())[UPKEEP_AUTHORITY], value);
  const store = { meta: () => null };
  assert.deepEqual(authorityPolicyChanges(store, base(), set(base(), 'upkeep.docs.maxFiles', 1)), [UPKEEP_AUTHORITY]);
  assert.deepEqual(authorityPolicyChanges(store, base(), set(base(), 'upkeep.mode', 'off')), []);
  assert.deepEqual(authorityPolicyChanges(store, set(base(), 'upkeep.mode', 'off'), base()), [UPKEEP_AUTHORITY]);
});

// One change per authority field, each a valid configuration that differs from the commissioned one.
const FIELD_CHANGES = {
  'upkeep.docs.include': c => set(c, 'upkeep.docs.include', ['README.md', 'docs/**/*.md', 'guides/**']),
  'upkeep.docs.exclude': c => set(c, 'upkeep.docs.exclude', []),
  'upkeep.docs.map': c => set(c, 'upkeep.docs.map', [{ docs: 'docs/**', paths: ['src/**'] }]),
  'upkeep.docs.maxFiles': c => set(c, 'upkeep.docs.maxFiles', 2),
  'upkeep.docs.maxChangedLines': c => set(c, 'upkeep.docs.maxChangedLines', 20),
  'upkeep.docs.maxWaiting': c => set(c, 'upkeep.docs.maxWaiting', 5),
  'upkeep.context.maxOpen': c => set(c, 'upkeep.context.maxOpen', 4),
  'upkeep.capture.maxOpen': c => set(c, 'upkeep.capture.maxOpen', 4),
  'upkeep.budget.maxInputChars': c => set(c, 'upkeep.budget.maxInputChars', 20000),
  'upkeep.budget.maxTurns': c => set(c, 'upkeep.budget.maxTurns', 3),
  'upkeep.budget.timeoutMs': c => set(c, 'upkeep.budget.timeoutMs', 120000),
  'upkeep.budget.maxModelRunsPerDay': c => set(c, 'upkeep.budget.maxModelRunsPerDay', 5),
  'upkeep.budget.maxTasksPerDay': c => set(c, 'upkeep.budget.maxTasksPerDay', 1),
  'upkeep.budget.maxTasksPerWeek': c => set(c, 'upkeep.budget.maxTasksPerWeek', 3),
  'upkeep.budget.maxFlowInvocations': c => set(c, 'upkeep.budget.maxFlowInvocations', 4),
  'upkeep.budget.maxOpenTasks': c => set(c, 'upkeep.budget.maxOpenTasks', 6),
  'upkeep.budget.maxQueueAgeMs': c => set(c, 'upkeep.budget.maxQueueAgeMs', 3600000),
  // Slice 6: the providers a context task may run a model step on is authority too.
  'upkeep.context.qualifiedProviders': c => set(c, 'upkeep.context.qualifiedProviders', ['claude']),
  'providers.upkeep': c => set(c, 'providers.upkeep', { provider: 'claude', model: 'small' }),
  'learnings.dir': c => set(c, 'learnings.dir', 'notes/learnings'),
  'learnings.maxSelected': c => set(c, 'learnings.maxSelected', 2),
  'learnings.maxChars': c => set(c, 'learnings.maxChars', 2000),
  'learnings.maxEntries': c => set(c, 'learnings.maxEntries', 10),
};

for (const schema of [1, 2]) {
  test(`schema ${schema}: a delegated config.update that alters any upkeep authority field is refused, and the operator's is not`, async t => {
    const f = await setup(t, { schema }), commissioned = base();
    for (const [field, change] of Object.entries(FIELD_CHANGES)) {
      const next = change(commissioned), before = f.store.meta('configDigest');
      assert.deepEqual(upkeepAuthorityChanges(commissioned, next).changed, [field], `the fixture changes exactly ${field}`);
      for (const payload of [{ config: next }, { config: next, replaceLive: true }]) {
        const refused = f.delegated('config.update', payload);
        assert.equal(refused.status, 'rejected', `${field}${payload.replaceLive ? ' (replaceLive)' : ''}`); assert.match(refused.error, /cannot change knowledge upkeep settings/); assert.ok(refused.error.includes(field), refused.error);
      }
      assert.equal(f.store.meta('configDigest'), before, `${field}: nothing was stored`);
    }
    // Dropping the block, or a key that falls back to a wider default, is a change too.
    const tightened = set(commissioned, 'upkeep.budget.maxTasksPerDay', 1);
    assert.equal(f.command('config.update', { config: tightened, note: 'The operator tightens a ceiling' }).status, 'completed');
    const widened = f.delegated('config.update', { config: commissioned }); assert.equal(widened.status, 'rejected'); assert.match(widened.error, /upkeep\.budget\.maxTasksPerDay/);
    const dropped = f.delegated('config.update', { config: without(tightened, 'learnings') }); assert.equal(dropped.status, 'rejected'); assert.match(dropped.error, /learnings\.dir/);
    // A delegated update that leaves upkeep alone still works where config.update is delegated.
    assert.equal(f.delegated('config.update', { config: { ...tightened, context: { files: [], maxChars: 2000 } } }).status, 'completed');
    // The mode: up is the operator's, down is anyone's who may write the configuration.
    const off = set({ ...tightened, context: { files: [], maxChars: 2000 } }, 'upkeep.mode', 'off');
    assert.equal(f.delegated('config.update', { config: off }).status, 'completed', 'a delegate may turn the mode down'); assert.equal(upkeepMode(f.stored()), 'off');
    const up = f.delegated('config.update', { config: set(off, 'upkeep.mode', 'observe') }); assert.equal(up.status, 'rejected'); assert.match(up.error, /upkeep\.mode/);
    // Down together with another field is refused whole: the exception covers the mode only.
    assert.equal(f.command('config.update', { config: set(off, 'upkeep.mode', 'observe'), note: 'The operator turns it on' }).status, 'completed');
    const both = f.delegated('config.update', { config: set(off, 'upkeep.docs.maxFiles', 1) }); assert.equal(both.status, 'rejected'); assert.match(both.error, /upkeep\.docs\.maxFiles/); assert.doesNotMatch(both.error, /upkeep\.mode,/); assert.equal(upkeepMode(f.stored()), 'observe');
    // The operator changes every field directly.
    for (const [field, change] of Object.entries(FIELD_CHANGES)) assert.equal(f.command('config.update', { config: change(set(off, 'upkeep.mode', 'observe')), note: `The operator changes ${field}` }).status, 'completed', field);
  });

  test(`schema ${schema}: a delegated settings.update can turn upkeep.mode down and nothing else; the operator turns it up`, async t => {
    const f = await setup(t, { schema }), digestBefore = f.store.meta('configDigest');
    // upkeep.mode is the one upkeep setting that is live; no other upkeep field can be reached this way.
    for (const path of ['upkeep.docs', 'upkeep.budget', 'upkeep.context', 'learnings.dir', 'providers.upkeep']) { const refused = f.delegated('settings.update', { changes: { [path]: {} } }); assert.equal(refused.status, 'rejected', path); assert.match(refused.error, /is not a live setting/); assert.equal(f.command('settings.update', { changes: { [path]: {} }, note: 'Not live for the operator either' }).status, 'rejected'); }
    assert.equal(f.delegated('settings.update', { changes: { 'upkeep.mode': 'apply' } }).status, 'rejected'); assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'apply' }, note: 'x' }).status, 'rejected', 'still validated');
    // propose is up from observe: the operator's alone; back down to observe is anyone's who may write settings.
    const proposeUp = f.delegated('settings.update', { changes: { 'upkeep.mode': 'propose' } }); assert.equal(proposeUp.status, 'rejected'); assert.match(proposeUp.error, /upkeep\.mode can only be changed by the operator/);
    assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'propose' }, note: 'The operator lets upkeep propose' }).status, 'completed'); assert.equal(upkeepMode(f.stored()), 'propose');
    const toObserve = f.delegated('settings.update', { changes: { 'upkeep.mode': 'observe' }, expected: { 'upkeep.mode': 'propose' } }); assert.equal(toObserve.status, 'completed', toObserve.error); assert.equal(upkeepMode(f.stored()), 'observe');
    // Down: a kill switch does not need the operator.
    const down = f.delegated('settings.update', { changes: { 'upkeep.mode': 'off' }, expected: { 'upkeep.mode': 'observe' } });
    assert.equal(down.status, 'completed', down.error); assert.equal(down.result.values['upkeep.mode'], 'off'); assert.equal(upkeepMode(f.stored()), 'off'); assert.equal(f.store.meta('configDigest'), digestBefore, 'a live change leaves the configuration digest alone');
    assert.deepEqual(f.stored().upkeep.docs, BLOCK.docs, 'the rest of the block is untouched');
    // Up, and a reset to the default from a lower value... there is none below off: both are refused to a delegate.
    for (const changes of [{ 'upkeep.mode': 'observe' }, { 'upkeep.mode': 'observe', 'policy.autoQueue': true }]) { const up = f.delegated('settings.update', { changes }); assert.equal(up.status, 'rejected'); assert.match(up.error, /upkeep\.mode can only be changed by the operator/); }
    assert.equal(upkeepMode(f.stored()), 'off'); assert.notEqual(f.stored().policy?.autoQueue, true, 'the whole command was refused');
    assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'The operator turns it on' }).status, 'completed'); assert.equal(upkeepMode(f.stored()), 'observe');
    // null resets to the default, off: that is down, so a delegate may.
    assert.equal(f.delegated('settings.update', { changes: { 'upkeep.mode': null } }).status, 'completed'); assert.equal(upkeepMode(f.stored()), 'off');
    // The kill switch survives a later configuration update from a file that still says observe.
    const kept = f.command('config.update', { config: base(), note: 'A pinned change from the file' }); assert.equal(kept.status, 'completed'); assert.ok(kept.result.keptLiveSettings.includes('upkeep.mode')); assert.equal(upkeepMode(f.stored()), 'off');
    // ... and a delegated update from that file does not turn it back on by any route.
    assert.equal(f.delegated('config.update', { config: base(), replaceLive: true }).status, 'rejected');
    // The settings view offers the two modes of this release.
    assert.deepEqual(settingsView(f.store).live['upkeep.mode'], { value: 'off', isDefault: true, type: 'choice', options: ['off', 'observe', 'propose'] });
  });
}

test('turning upkeep on is refused while an open task the factory did not make is in the reserved namespace; with upkeep on such a task cannot be changed', async t => {
  const f = await setup(t, { config: set(base(), 'upkeep.mode', 'off') });
  // A task from before the reservation, written as an earlier release stored it.
  const legacy = { id: 'Upkeep:legacy', title: 'Fictional task from before the reservation', acceptance: ['Observed'], revision: digest('legacy'), approvedRevision: null, approvalVersion: 1 };
  f.store.put('task', legacy);
  for (const attempt of [() => f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }), () => f.command('config.update', { config: base(), note: 'On, from the file' })]) {
    const refused = attempt(); assert.equal(refused.status, 'rejected'); assert.match(refused.error, /knowledge upkeep cannot be turned on: open task in the reserved upkeep: namespace that the factory did not make: Upkeep:legacy/);
  }
  assert.equal(upkeepMode(f.stored()), 'off');
  // Commissioning a configuration that already has upkeep on (written by an earlier release, say) reports it.
  const stubs = { forgeTransport: async () => ({}), providerPreflight: async () => ({}), run: async () => ({ code: 0, stdout: '', stderr: '' }) };
  assert.equal((await doctor(f.stateDir, stubs)).reasons.some(reason => /knowledge upkeep/.test(reason)), false, 'with upkeep off the namespace is not looked at');
  f.store.setMeta('config', base());
  const checked = await doctor(f.stateDir, stubs); assert.equal(checked.ready, false);
  assert.ok(checked.reasons.some(reason => /^knowledge upkeep is on \(upkeep\.mode\): open task in the reserved upkeep: namespace that the factory did not make: Upkeep:legacy/.test(reason)), checked.reasons.join(' | '));
  f.store.setMeta('config', set(base(), 'upkeep.mode', 'off'));
  // With upkeep off it stays editable, so that it can be closed.
  const closed = f.command('task.put', { task: { id: legacy.id, title: legacy.title, acceptance: legacy.acceptance, closed: true } }); assert.equal(closed.status, 'completed', closed.error);
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On, now that it is closed' }).status, 'completed');
  // With upkeep on, a task already in the namespace can no longer be changed through task.put; labels still apply.
  const edit = f.command('task.put', { task: { id: legacy.id, title: 'Reopened', acceptance: legacy.acceptance } }); assert.equal(edit.status, 'rejected'); assert.match(edit.error, /knowledge upkeep is on, so it cannot be changed here/);
  assert.equal(f.command('task.label', { taskId: legacy.id, labels: ['history'] }).status, 'completed');
  assert.equal(f.store.need('task', legacy.id).upkeep, undefined, 'it never gains a marker');
  // The lookup never falls back to reading every task: unverified, the answer is a refusal.
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }).status, 'completed');
  f.store.db.exec('DROP INDEX records_open_task_lower_id');
  const unverified = f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }); assert.equal(unverified.status, 'rejected'); assert.match(unverified.error, /cannot be turned on: knowledge upkeep cannot read task through its index/);
});
