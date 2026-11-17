// Knowledge upkeep settings: the `upkeep` and `learnings` configuration blocks with their defaults,
// their validation, the mode, and the upkeep authority value (knowledge-upkeep design, 9.2 and 12).
//
// What upkeep may create and how large is authority, as recurring-task templates are. The
// normalised value below is compared wherever a configuration is written by someone other than
// the operator, on both schemas; the one exception is turning the mode down, which never widens
// what the factory does.
//
// The modes: `off`; `observe` (the pre-filter and the model run and their outcomes are recorded,
// and no candidate row or task is written); `propose` (slice 5 part B: what the validator kept of
// the docs part is recorded as candidates, and the factory creates docs follow-up tasks from them,
// unapproved, within the ceilings; operations/upkeep-tasks.mjs). Since slice 6, `propose` also records
// governing-context proposals, which only the operator accepts into a `context` task. Capture
// candidates are still only counted: their rows and tasks come with slice 7.
//
// `upkeep.context.qualifiedProviders` (slice 6) lists the providers the operator has shown, with the
// provider instruction-loading checklist (docs/qualification/provider-instructions.md), to start
// without reading instruction files from the worktree. A `context` task runs no model step on any
// other provider: it is refused at admission and before the provider starts. Empty by default, so
// no context task runs until the operator records a passed check. It is authority, like the rest.
import { assert, digest } from './contracts.mjs';
import { definitionKind } from './workflow-kinds.mjs';

export const UPKEEP_OPERATION = 'knowledge.upkeep';
// The read-only job that raises stale-learning candidates (11.4; slice 8). It is a built-in
// maintenance job of the shared lane, enqueued by hand or on a schedule; it calls no model.
export const LEARNINGS_CHECK_OPERATION = 'learnings.check';
// The category of every upkeep-origin task (6.6): Stats groups by it, and 7.3 selects by it.
export const UPKEEP_TASK_CATEGORY = 'knowledge-upkeep';
export const UPKEEP_MODEL_WORKFLOW = `maintenance/${UPKEEP_OPERATION}`;
export const isUpkeepJob = job => job?.operation === UPKEEP_OPERATION;
// The upkeep job's own flow: a maintenance flow whose one node runs the upkeep operation. It has
// its own lane (5.2): it is never the occupant of the built-in maintenance lane.
export const isUpkeepFlow = flow => flow?.kind === 'maintenance' && !flow.integration && flow.workflow?.nodes?.[flow.workflow?.start]?.action?.operation === UPKEEP_OPERATION;
// A provider role this release can run: a provider, a model, subscription-backed. A stored value
// that is not one (an earlier release ignored providers.upkeep) is never used as a route.
export const usableProviderRoute = spec => Boolean(spec) && typeof spec === 'object' && !Array.isArray(spec) && ['codex', 'claude'].includes(spec.provider) && typeof spec.model === 'string' && spec.model.length > 0 && (spec.billingMode ?? 'subscription') === 'subscription';
// The configuration with the pinned upkeep route (operations/upkeep-route.mjs) standing in for
// providers.upkeep, when the project configures none and the pin is a copy of the reviewer's route.
// With providers.upkeep set, or no such pin, the configuration is returned as it is.
export function withUpkeepRoute(config, pin) {
  if (usableProviderRoute(config?.providers?.upkeep) || pin?.source !== 'providers.reviewer' || !usableProviderRoute(pin.route)) return config;
  return { ...config, providers: { ...config.providers, upkeep: structuredClone(pin.route) } };
}
// Ordered from least to most that the factory does. Turning down is moving toward `off`.
export const UPKEEP_DESIGN_MODES = Object.freeze(['off', 'observe', 'propose']);
export const UPKEEP_MODES = Object.freeze(['off', 'observe', 'propose']);
const rank = mode => UPKEEP_DESIGN_MODES.indexOf(mode);

// Every limit may be lowered. None may be raised above the value below, which is also its default.
// Settled ceilings (operator decisions): docs.maxFiles, docs.maxChangedLines, docs.maxWaiting,
// context.maxOpen and capture.maxOpen (Q7); budget.maxTasksPerDay, maxTasksPerWeek,
// maxFlowInvocations and maxQueueAgeMs (N6); budget.maxOpenTasks (it bounds the namespace lookup);
// learnings.maxEntries (Q3); budget.maxInputChars, maxTurns, timeoutMs and maxModelRunsPerDay
// (settled with slice 3: they bound what one assessment may read and cost, and how many may run,
// so they are ceilings like the rest). learnings.maxSelected and maxChars (slice 8, which uses them)
// are ceilings too, at the design's defaults: they bound what every later planner, plan reviewer,
// builder and reviewer is shown, so a project may lower them and never raise them.
const LIMITS = Object.freeze({
  docs: { maxFiles: [1, 3], maxChangedLines: [1, 40], maxWaiting: [0, 10] },
  context: { maxOpen: [0, 10] },
  capture: { maxOpen: [0, 10] },
  budget: { maxInputChars: [1000, 40000], maxTurns: [1, 6], timeoutMs: [10000, 300000], maxModelRunsPerDay: [0, 30], maxTasksPerDay: [0, 2], maxTasksPerWeek: [0, 6], maxFlowInvocations: [1, 8], maxOpenTasks: [0, 12], maxQueueAgeMs: [60000, 86400000] },
});
const LEARNING_LIMITS = Object.freeze({ maxSelected: [0, 5], maxChars: [0, 6000], maxEntries: [0, 40] });
const defaults = limits => Object.fromEntries(Object.entries(limits).map(([name, [, most]]) => [name, most]));
// The providers whose instruction suppression a context task may rely on (slice 6). Only these two
// exist; listing one is the operator's statement that its live check passed on this host.
export const CONTEXT_QUALIFIABLE_PROVIDERS = Object.freeze(['codex', 'claude']);
const providerList = value => Array.isArray(value) && value.length <= CONTEXT_QUALIFIABLE_PROVIDERS.length && value.every(name => CONTEXT_QUALIFIABLE_PROVIDERS.includes(name)) && new Set(value).size === value.length;
export const UPKEEP_DEFAULTS = Object.freeze({ mode: 'off', docs: Object.freeze({ include: Object.freeze([]), exclude: Object.freeze([]), map: Object.freeze([]), ...defaults(LIMITS.docs), workflow: null }), context: Object.freeze({ ...defaults(LIMITS.context), qualifiedProviders: Object.freeze([]) }), capture: Object.freeze(defaults(LIMITS.capture)), budget: Object.freeze(defaults(LIMITS.budget)) });
export const LEARNINGS_DEFAULTS = Object.freeze({ dir: null, ...defaults(LEARNING_LIMITS) });

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A repository-relative glob or path: no leading slash, no `..` component, no NUL or backslash.
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.startsWith('/') && !value.includes('\0') && !value.includes('\\') && !value.split('/').includes('..');
const globs = (value, most) => Array.isArray(value) && value.length <= most && value.every(relative) && new Set(value).size === value.length;
function bounded(block, limits, where) {
  for (const [name, [least, most]] of Object.entries(limits)) assert(block[name] === undefined || Number.isSafeInteger(block[name]) && block[name] >= least && block[name] <= most, `${where}.${name} must be a whole number from ${least} to ${most}`);
}
function onlyKeys(block, allowed, where) {
  assert(object(block), `${where} must be an object`);
  const unknown = Object.keys(block).filter(key => !allowed.includes(key));
  assert(!unknown.length, `${where} supports only ${allowed.join(', ')} (found ${unknown.join(', ')})`);
}

// Both blocks are optional; absent means off. Unknown keys are refused, so nothing that bears
// authority can sit outside the value compared below. Called by validateConfig for every mode of
// project, so a rehearsal configuration cannot carry an invalid block into delivery either.
// This is the whole of what the validator says about the two blocks: validateConfig calls it, and
// so does everything that asks whether a stored block is one this release accepts
// (upkeepBlockProblem below), so the two answers cannot differ. A workflow selector's kind is
// resolved as the catalog compiler resolves it (core/workflow-kinds.mjs).
export function validateUpkeepConfig(config = {}) {
  const upkeep = config.upkeep;
  if (upkeep !== undefined) {
    onlyKeys(upkeep, ['mode', 'docs', 'context', 'capture', 'budget'], 'upkeep');
    assert(upkeep.mode === undefined || UPKEEP_MODES.includes(upkeep.mode), `upkeep.mode must be one of ${UPKEEP_MODES.join(', ')}`);
    if (upkeep.docs !== undefined) {
      onlyKeys(upkeep.docs, ['include', 'exclude', 'map', ...Object.keys(LIMITS.docs), 'workflow'], 'upkeep.docs');
      for (const name of ['include', 'exclude']) assert(upkeep.docs[name] === undefined || globs(upkeep.docs[name], 64), `upkeep.docs.${name} must be a list of at most 64 distinct repository-relative globs`);
      assert(upkeep.docs.map === undefined || Array.isArray(upkeep.docs.map) && upkeep.docs.map.length <= 32 && upkeep.docs.map.every(row => object(row) && Object.keys(row).every(key => ['docs', 'paths'].includes(key)) && relative(row.docs) && globs(row.paths, 32) && row.paths.length > 0), 'upkeep.docs.map must be a list of at most 32 entries {docs: glob, paths: [globs]}');
      bounded(upkeep.docs, LIMITS.docs, 'upkeep.docs');
      if (upkeep.docs.workflow !== undefined) {
        // 7.3: an explicit selector must name a catalog definition that delivers a change.
        const name = upkeep.docs.workflow, definitions = object(config.workflows?.definitions) ? config.workflows.definitions : {}, definition = typeof name === 'string' && Object.hasOwn(definitions, name) && object(definitions[name]) ? definitions[name] : null;
        assert(typeof name === 'string' && name, 'upkeep.docs.workflow must name a workflow');
        assert(config.workflows, 'upkeep.docs.workflow needs a workflow catalog; without one every task runs through the project\'s one workflow');
        assert(definition, `upkeep.docs.workflow names ${JSON.stringify(name)}, which is not a workflow in the catalog`);
        assert(definitionKind(definition) !== 'task', `upkeep.docs.workflow names ${JSON.stringify(name)}, a workflow of kind task; an upkeep task is delivered by a change or document workflow`);
      }
    }
    for (const part of ['context', 'capture', 'budget']) if (upkeep[part] !== undefined) { onlyKeys(upkeep[part], [...Object.keys(LIMITS[part]), ...(part === 'context' ? ['qualifiedProviders'] : [])], `upkeep.${part}`); bounded(upkeep[part], LIMITS[part], `upkeep.${part}`); }
    assert(upkeep.context?.qualifiedProviders === undefined || providerList(upkeep.context.qualifiedProviders), `upkeep.context.qualifiedProviders must list distinct providers from ${CONTEXT_QUALIFIABLE_PROVIDERS.join(', ')}: those whose instruction-loading check passed on this host (docs/qualification/provider-instructions.md)`);
    // 7.3: where the factory creates docs follow-ups (propose) through a catalog and no explicit
    // selector is set, the task has no workflow field and no labels, so the first rule for its
    // category knowledge-upkeep applies, then the default. That must reach a workflow that
    // delivers a change: never none, and never one of kind task.
    if (upkeep.mode === 'propose' && config.workflows && upkeep.docs?.workflow === undefined) {
      const definitions = object(config.workflows.definitions) ? config.workflows.definitions : {}, selection = object(config.workflows.selection) ? config.workflows.selection : {};
      const rule = Array.isArray(selection.rules) ? selection.rules.find(row => object(row) && row.category === UPKEEP_TASK_CATEGORY && row.label === undefined) : null, name = rule?.workflow ?? selection.default;
      assert(typeof name === 'string' && object(definitions[name]), `upkeep.mode "propose" needs a workflow for docs follow-ups: no selection rule for category ${UPKEEP_TASK_CATEGORY} and no default; set upkeep.docs.workflow or add a rule`);
      assert(definitionKind(definitions[name]) !== 'task', `upkeep.mode "propose" would route docs follow-ups (category ${UPKEEP_TASK_CATEGORY}) to ${JSON.stringify(name)}, a workflow of kind task; set upkeep.docs.workflow to a change or document workflow`);
    }
  }
  const learnings = config.learnings;
  if (learnings !== undefined) {
    onlyKeys(learnings, ['dir', ...Object.keys(LEARNING_LIMITS)], 'learnings');
    assert(learnings.dir === undefined || validDirectory(learnings.dir), 'learnings.dir must be a repository-relative directory with no hidden folder on its path (no component starting with "."): provider instructions, skills and settings live in hidden folders, and a learning is never one of them');
    bounded(learnings, LEARNING_LIMITS, 'learnings');
    // 11.1: the store is outside governing context. A directory that holds a configured governing
    // path, or lies inside one, is refused as written (compared without regard to case); where links
    // lead is judged in the tree whenever the store is read (operations/learnings.mjs).
    if (learnings.dir !== undefined) for (const entry of Array.isArray(config.context?.files) ? config.context.files : []) {
      const path = typeof entry?.path === 'string' ? governedPath(entry.path) : null; if (!path) continue;
      const dir = learnings.dir.toLowerCase();
      assert(!(path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`)), `learnings.dir ${JSON.stringify(learnings.dir)} ${path === dir || dir.startsWith(`${path}/`) ? 'is inside' : 'holds'} the governing context entry ${JSON.stringify(entry.id ?? entry.path)} (${entry.path}); learnings live outside governing context`);
    }
  }
  return config;
}
// A configured governing path as written, lower-cased, without `./` and empty components: what the
// learnings directory is compared with. Null for a path that is not plainly repository-relative.
const governedPath = path => { const parts = path.split('/').filter(part => part && part !== '.'); return path.startsWith('/') || parts.includes('..') || !parts.length ? null : parts.join('/').toLowerCase(); };

// ---- Reading a stored configuration ----
// A stored configuration is not necessarily one this release would accept: the release before
// ignored both blocks, so a project may hold a string where a list belongs, a limit that is too
// large, or a mode this release does not have. Nothing below assumes a valid block. Each field is
// read on its own as its value, its default when absent, or `unreadable` when it is not a value
// this release accepts (or sits inside something that is not an object).
const within = ([least, most]) => value => Number.isSafeInteger(value) && value >= least && value <= most;
const validMap = value => Array.isArray(value) && value.length <= 32 && value.every(row => object(row) && Object.keys(row).every(key => ['docs', 'paths'].includes(key)) && relative(row.docs) && globs(row.paths, 32) && row.paths.length > 0);
// A learnings directory: repository-relative, no wildcard, and no hidden component (slice 8).
const validDirectory = value => relative(value) && !/[*?]/.test(value) && value.split('/').every(part => part && !part.startsWith('.'));
const sorted = list => [...list].sort();
// [name in the authority value, path in the configuration, valid, default, how it is compared]
const limitFields = (prefix, path, limits) => Object.entries(limits).map(([name, range]) => [`${prefix}.${name}`, [...path, name], within(range), range[1]]);
const FIELDS = Object.freeze([
  ['upkeep.mode', ['upkeep', 'mode'], value => UPKEEP_MODES.includes(value), 'off'],
  ['upkeep.docs.include', ['upkeep', 'docs', 'include'], value => globs(value, 64), [], sorted],
  ['upkeep.docs.exclude', ['upkeep', 'docs', 'exclude'], value => globs(value, 64), [], sorted],
  ['upkeep.docs.map', ['upkeep', 'docs', 'map'], validMap, [], list => list.map(row => ({ docs: row.docs, paths: sorted(row.paths) })).sort((a, b) => digest(a).localeCompare(digest(b)))],
  ...limitFields('upkeep.docs', ['upkeep', 'docs'], LIMITS.docs),
  ['upkeep.docs.workflow', ['upkeep', 'docs', 'workflow'], value => typeof value === 'string' && value.length > 0, null],
  ...['context', 'capture', 'budget'].flatMap(part => limitFields(`upkeep.${part}`, ['upkeep', part], LIMITS[part])),
  ['upkeep.context.qualifiedProviders', ['upkeep', 'context', 'qualifiedProviders'], providerList, [], sorted],
  ['learnings.dir', ['learnings', 'dir'], validDirectory, null],
  ...limitFields('learnings', ['learnings'], LEARNING_LIMITS),
]);
function readField(config, [, path, valid, fallback]) {
  let at = config;
  for (const key of path) { if (at === undefined) break; if (!object(at)) return { unreadable: at }; at = at[key]; }
  return at === undefined ? { value: fallback } : valid(at) ? { value: at } : { unreadable: at };
}
const fields = config => Object.fromEntries(FIELDS.map(field => [field[0], readField(object(config) ? config : {}, field)]));
// Why this release refuses the stored blocks, or null. With a problem, upkeep reads as off.
export function upkeepBlockProblem(config) { try { validateUpkeepConfig(object(config) ? config : {}); return null; } catch (error) { return error.message; } }
const blocksValid = config => upkeepBlockProblem(config) === null;

// The settings with defaults applied. A stored block that this release would refuse reads as off,
// with every unreadable field at its default: the factory does less, never more, and never fails
// on what an earlier release stored.
export function upkeepSettings(config = {}) {
  const read = fields(config), value = name => { const item = Object.hasOwn(read[name], 'value') ? read[name].value : FIELDS.find(field => field[0] === name)[3]; return structuredClone(item); };
  const part = name => Object.fromEntries(Object.keys(LIMITS[name]).map(key => [key, value(`upkeep.${name}.${key}`)]));
  return { mode: blocksValid(config) ? value('upkeep.mode') : 'off', docs: { include: value('upkeep.docs.include'), exclude: value('upkeep.docs.exclude'), map: value('upkeep.docs.map').map(row => ({ docs: row.docs, paths: [...row.paths] })), ...part('docs'), workflow: value('upkeep.docs.workflow') }, context: { ...part('context'), qualifiedProviders: value('upkeep.context.qualifiedProviders') }, capture: part('capture'), budget: part('budget') };
}
export const learningsSettings = (config = {}) => { const read = fields(config); return Object.fromEntries(['dir', ...Object.keys(LEARNING_LIMITS)].map(key => [key, Object.hasOwn(read[`learnings.${key}`], 'value') ? read[`learnings.${key}`].value : LEARNINGS_DEFAULTS[key]])); };
export const upkeepMode = config => upkeepSettings(config).mode;
export const upkeepOn = config => upkeepMode(config) !== 'off';

// 9.2. The normalised upkeep authority value, one entry per field: the mode; the docs scope with
// its limits and workflow; the context and capture caps; the budgets; the upkeep model role and its
// step defaults, which decide what runs; and the learnings directory and caps, which bound what
// later agents are shown. Order-insensitive lists are sorted, so rewriting a list is not a change.
// A field this release cannot read is kept as a digest of what is stored, and so is a whole block
// this release would refuse (an unknown key is in no field), so any change away from it is a
// change of authority: the operator may make it, a delegate may not, not even by "turning the
// mode down".
export const STORED_BLOCK = name => `${name} (stored block)`;
export function upkeepAuthority(config = {}) {
  const read = fields(config), value = {}, entry = field => { const item = read[field[0]]; return Object.hasOwn(item, 'value') ? (field[4] ?? (x => x))(item.value) : { unreadable: digest(item.unreadable ?? null) }; };
  for (const field of FIELDS.filter(row => row[0].startsWith('upkeep.'))) value[field[0]] = entry(field);
  value['providers.upkeep'] = config?.providers?.upkeep ?? null;
  value[`stepModels.${UPKEEP_MODEL_WORKFLOW}`] = config?.stepModels?.[UPKEEP_MODEL_WORKFLOW] ?? null;
  for (const field of FIELDS.filter(row => row[0].startsWith('learnings.'))) value[field[0]] = entry(field);
  for (const name of ['upkeep', 'learnings']) value[STORED_BLOCK(name)] = upkeepBlockProblem({ ...(object(config) ? config : {}), [name === 'upkeep' ? 'learnings' : 'upkeep']: undefined }) ? { unreadable: digest(config?.[name] ?? null) } : null;
  return value;
}
// The authority fields whose effective value differs between two configurations. `turnedDown` says
// the mode moved toward off from a mode this release can read, which anyone who may write settings
// is allowed to do. `turnedUp` compares the modes in force, so correcting a block that read as off
// into one that observes counts as turning upkeep on.
export function upkeepAuthorityChanges(before, after) {
  const was = upkeepAuthority(before), is = upkeepAuthority(after);
  const changed = Object.keys(is).filter(name => digest(was[name] ?? null) !== digest(is[name] ?? null));
  const readable = mode => UPKEEP_MODES.includes(mode);
  return { changed, turnedDown: changed.includes('upkeep.mode') && readable(was['upkeep.mode']) && readable(is['upkeep.mode']) && rank(is['upkeep.mode']) < rank(was['upkeep.mode']), turnedUp: rank(upkeepMode(after)) > rank(upkeepMode(before)) };
}
// What a writer who is not the operator may not change: every authority field, except the mode
// when it was turned down.
export function delegatedUpkeepChanges(before, after) {
  const { changed, turnedDown } = upkeepAuthorityChanges(before, after);
  return changed.filter(name => !(name === 'upkeep.mode' && turnedDown));
}
