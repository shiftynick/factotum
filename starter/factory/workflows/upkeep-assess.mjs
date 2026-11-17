// Knowledge upkeep: the assessment one upkeep run makes (knowledge-upkeep design, section 6).
//
// First the deterministic part: classification (6.1) and the pre-filter (6.2), from records and
// Git. Most runs end there, with no model call. When the pre-filter finds something to assess, one
// read-only model call follows (6.3), within the daily limit (6.6), and its answer goes through
// the deterministic validator (6.4). It counts what the validator kept and dropped; in `propose` the
// docs candidates it kept are also returned, for the run's settlement to record (slice 5 part B).
// The attempt itself writes no candidate row and no task. The engine records the result on the run
// when it settles the attempt (operations/upkeep-runs.mjs).
//
// Records are read by key (4.5): the run, the source flow and its retrospective, the day's row and
// three meta rows; the open candidates come from their own partial index. Git is read through
// hash-verified objects (core/verified-git.mjs), never through diff, attributes or filters: one
// comparison of the merge commit's tree with the integrated base, and one search of the declared
// docs and the governing files at the merge commit. A merge commit the project repository does
// not hold yet is fetched once. The model works in a throwaway detached checkout of the merge
// commit, made without workspace.setup and removed afterwards.
import { join } from 'node:path';
import { atomicJSON } from '../core/contracts.mjs';
import { stepSpec, upkeepModelRole } from '../core/step-models.mjs';
import { UPKEEP_MODEL_WORKFLOW } from '../core/upkeep-config.mjs';
import { accountingResult } from '../operations/usage-accounting.mjs';
import { anchorDirectories } from '../operations/upkeep-class-key.mjs';
import { assessmentInput, assessmentOutcome, assessmentPrompt, assessmentSchema, validateAssessment } from '../operations/upkeep-assessment.mjs';
import { reserveUpkeepModelRunInTransaction } from '../operations/upkeep-budget.mjs';
import { candidateView, expireOpenCandidatesInTransaction, isUpkeepCandidate } from '../operations/upkeep-candidates.mjs';
import { upkeepSelectionConfig } from '../operations/upkeep-route.mjs';
import { upkeepProviderTimeoutMs } from '../operations/effect-timeouts.mjs';
import { knownSecrets } from '../operations/known-secrets.mjs';
import { recordPrompt } from './prompt-record.mjs';
import { invoke } from '../adapters/providers/index.mjs';
import { Store } from '../core/store.mjs';
import { VerifiedObjects } from '../core/verified-git.mjs';
import { gitTreeLookup, resolveTreePath, treeView } from '../core/tree-paths.mjs';
import { upgradeOwned } from '../core/install-layout.mjs';
import { learningsSettings, upkeepMode, upkeepSettings } from '../core/upkeep-config.mjs';
import { UPKEEP_FINDING_SOURCE, openUpkeepCandidates, upkeepOpen, upkeepRun, upkeepSuspended } from '../operations/upkeep-records.mjs';
import { candidateFiles, classifyDocs, contextFiles, mayHoldMatch, prefilterDecision } from '../operations/upkeep-prefilter.mjs';

// Bounds on what one run reads from Git. Past them the run says so (`docs-scan-truncated`).
export const UPKEEP_SCAN_LIMITS = Object.freeze({ touchedPaths: 5000, listedFiles: 20000, filesRead: 2000, fileBytes: 1024 * 1024 });
const OBJECT = /^[a-f\d]{40,64}$/i, DIRECTORY = '40000', FILE_MODES = ['100644', '100755'];
const entries = (objects, tree) => tree ? new Map(objects.tree(tree).map(entry => [entry.name, entry])) : new Map();

// Every path whose entry differs between two trees, descending only where the trees differ. A
// rename is a removal and an addition. One batch of object reads per directory level. Each row
// names the blob of a regular file on the side it exists (`was`, `is`); a link or a submodule has none.
const sideBlobs = (was, is) => ({ ...(was && FILE_MODES.includes(was.mode) ? { was: was.id } : {}), ...(is && FILE_MODES.includes(is.mode) ? { is: is.id } : {}) });
export function comparedTrees(objects, base, merged, limit = UPKEEP_SCAN_LIMITS.touchedPaths) {
  const touched = []; let frontier = [{ path: '', a: base, b: merged }], truncated = false;
  while (frontier.length && !truncated) {
    objects.read(frontier.flatMap(node => [node.a, node.b]).filter(Boolean));
    const next = [];
    for (const node of frontier) {
      const left = entries(objects, node.a), right = entries(objects, node.b);
      for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        const was = left.get(name), is = right.get(name), path = `${node.path}${name}`;
        if (was && is && was.id === is.id && was.mode === is.mode) continue;
        const wasDirectory = was?.mode === DIRECTORY, isDirectory = is?.mode === DIRECTORY;
        if (wasDirectory || isDirectory) next.push({ path: `${path}/`, a: wasDirectory ? was.id : null, b: isDirectory ? is.id : null });
        if (was && !wasDirectory && is && !isDirectory) touched.push({ path, change: 'modified', ...sideBlobs(was, is) });
        else { if (was && !wasDirectory) touched.push({ path, change: 'deleted', ...sideBlobs(was, null) }); if (is && !isDirectory) touched.push({ path, change: 'added', ...sideBlobs(null, is) }); }
        if (touched.length >= limit) { truncated = true; break; }
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { touched: touched.slice(0, limit), truncated };
}
// The regular files of a tree inside the folders the globs can reach: path -> blob id. Symbolic
// links and submodules are not files here. One batch of object reads per directory level.
export function listedFiles(objects, tree, globs, limit = UPKEEP_SCAN_LIMITS.listedFiles) {
  const files = new Map(); let frontier = globs.length ? [{ path: '', id: tree }] : [], truncated = false;
  while (frontier.length && !truncated) {
    objects.read(frontier.map(node => node.id));
    const next = [];
    for (const node of frontier) for (const entry of objects.tree(node.id)) {
      const path = `${node.path}${entry.name}`;
      if (entry.mode === DIRECTORY) { if (mayHoldMatch(globs, `${path}/`)) next.push({ path: `${path}/`, id: entry.id }); }
      else if (FILE_MODES.includes(entry.mode)) { if (files.size >= limit) { truncated = true; break; } files.set(path, entry.id); }
    }
    frontier = next;
  }
  return { files, truncated };
}
// The blob a resolved path names in a tree, or null.
function blobAt(lookup, path) {
  const found = resolveTreePath(lookup, path); if (found.unresolvable || !found.exists || found.type !== 'file') return null;
  const parts = found.path.split('/'), entry = lookup(parts.slice(0, -1), parts.at(-1));
  return entry?.type === 'file' ? entry.id : null;
}
// A file's text, or undefined when it is too large or is not text.
function textOf(body) {
  if (!body || body.length > UPKEEP_SCAN_LIMITS.fileBytes || body.includes(0)) return undefined;
  const text = body.toString('utf8'); return Buffer.from(text, 'utf8').equals(body) ? text : undefined;
}

const report = (outcome, reason, stage, extra = {}) => ({ route: 'pass', providerInvocations: [], upkeepRun: { outcome, reason, stage, flags: [], counts: {}, ...extra } });

// Limit reports travel with the invocation record; usage accounting ignores them.
const invocationRecord = result => ({ ...accountingResult(result), ...(result.limits?.length ? { limits: result.limits } : {}) });
const errorWith = (error, invocations) => { if (!Array.isArray(error.providerInvocations) || !error.providerInvocations.length) error.providerInvocations = invocations; return error; };

// The model stage of a run whose pre-filter found something to assess: the evidence, the day's
// reservation, the one invocation, the validator. Returns what the run records, the invocations
// the attempt's receipt names, and the day the model run was reserved on.
async function assessWithModel({ intent, store, run, config, settings, objects, touched, classified, contexts, found, assess, signals, text, blobs, flowId, runGit, providerInvoke, signal, deadlineAt, now }) {
  const action = intent.action, root = intent.projectRoot ?? intent.cwd, artifactDir = action.artifactDir ?? join(action.stateDir, 'maintenance', action.flowId);
  // The flow pinned its route at admission. A flow without one selects as admission would: under the pinned upkeep route.
  const selection = upkeepSelectionConfig(store, config), role = upkeepModelRole(selection), route = action.modelRoute ?? stepSpec(selection.providers[role], config.stepModels?.[UPKEEP_MODEL_WORKFLOW]?.run);
  // A provider usage hold: nothing is started, and nothing is moved to another provider unasked (5.3).
  const startable = [route.provider, ...(route.allowFallback && route.fallback ? [route.fallback.provider ?? route.provider] : [])];
  if (startable.every(provider => (action.providerHolds ?? []).includes(provider))) return { report: { outcome: 'abstained', reason: 'assessment-unavailable', stage: 'reservation' } };

  // 6.3, 6.5: the bounded evidence. Texts of touched files are read on demand, through verified objects.
  const all = touched.map(row => row.path), removed = touched.filter(row => row.change === 'deleted').map(row => row.path), edited = new Set(all);
  const refs = path => edited.has(path) ? removed.filter(other => other !== path) : all;
  const files = [...(assess.docs ? found.docCandidates.map(path => ({ path, kind: 'docs' })) : []), ...(assess.context ? found.contextCandidates.map(path => ({ path, kind: 'context' })) : [])].filter(file => typeof text(file.path) === 'string').map(file => ({ ...file, blob: blobs.get(file.path), text: text(file.path), refs: refs(file.path) }));
  const sides = new Map(touched.map(row => [row.path, row]));
  const content = path => { const row = sides.get(path), ids = [row?.was, row?.is].filter(Boolean); objects.read(ids); return { before: row?.was ? textOf(objects.blob(row.was)) : undefined, after: row?.is ? textOf(objects.blob(row.is)) : undefined, blob: row?.is ?? row?.was ?? null }; };
  // The open candidates: their own partial index, read once, whatever the audit backlog. Those
  // past their age expire here, where the set is read anyway (4.5), so the model is not shown a
  // title that is no longer open.
  // A transaction is opened only when one is overdue, and the set is then read again inside it.
  let openCandidates = [];
  try {
    const live = openUpkeepCandidates(store), overdue = live.some(row => isUpkeepCandidate(row) && candidateView(row, now()).overdue);
    openCandidates = (overdue ? store.tx(() => expireOpenCandidatesInTransaction(store, { nowMs: now() })).open : live).filter(row => row.source === UPKEEP_FINDING_SOURCE && typeof row.title === 'string').map(row => row.title);
  } catch { /* an unverified kind suspends upkeep at its next start */ }
  const anchors = [...(config.fastChecks?.checks ?? []).map(check => ({ value: `check:${check.id}`, by: 'operator' })), ...(config.context?.files ?? []).filter(entry => typeof entry?.id === 'string' && entry.id).map(entry => ({ value: `context:${entry.id}`, by: 'operator' })), ...anchorDirectories(signals.map(row => row.file).filter(Boolean)).map(dir => ({ value: `dir:${dir}`, by: 'repository' }))];
  const source = store.get('flow', flowId), task = source?.taskSnapshot ?? {};
  const input = assessmentInput({ flowId, task: { title: task.title, acceptance: task.acceptance }, touched, content, files, signals, existing: { rules: (config.fastChecks?.checks ?? []).flatMap(check => (check.rules ?? []).map(rule => ({ checkId: check.id, rule }))), openCandidates }, anchors, maxInputChars: settings.budget.maxInputChars });
  const { prompt } = assessmentPrompt(input.items), schema = assessmentSchema({ maxFiles: settings.docs.maxFiles });
  const timeoutMs = upkeepProviderTimeoutMs(config, deadlineAt, now());
  if (!(timeoutMs >= 1000)) throw new Error('the upkeep step has no time left for its model call');

  // The throwaway checkout of the merge commit, then the reservation, then the one invocation.
  const checkout = join(action.stateDir, 'maintenance', action.flowId, 'checkout'), git = args => runGit(args, { cwd: root, env: process.env, timeoutMs: 60000 });
  const added = await git(['worktree', 'add', '--detach', checkout, run.mergeCommit]);
  if (added.code !== 0) throw new Error(`could not prepare the upkeep checkout: ${String(added.stderr ?? '').trim().slice(0, 300)}`);
  let observation, invoked = false;
  try {
    // 6.6: one transaction reads the clock and the day's row, refuses at the limit, and reserves under
    // this attempt's id. The day is the one it is now, after the fetch and the checkout, not the one the step began on.
    const reserved = store.tx(() => reserveUpkeepModelRunInTransaction(store, { attemptId: intent.attemptId, flowId, limit: settings.budget.maxModelRunsPerDay, now }));
    if (!reserved.reserved) return { report: { outcome: 'abstained', reason: 'budget', stage: 'reservation' } };
    const providerDir = join(artifactDir, 'provider'); recordPrompt(providerDir, prompt, knownSecrets(config));
    invoked = true;
    observation = await providerInvoke({ ...route, role: 'upkeep', readOnly: true, maxTurns: Math.min(route.maxTurns ?? settings.budget.maxTurns, settings.budget.maxTurns), ...(action.providerHolds?.length ? { heldProviders: action.providerHolds } : {}), cwd: checkout, artifactDir: providerDir, prompt, schema, timeoutMs }, { signal });
    // 6.4: whatever came back, only what passes every rule is kept; nothing is repaired or asked again.
    const validated = validateAssessment(observation.result, input, { maxFiles: settings.docs.maxFiles, allowed: { docs: new Set(classified.docs), context: new Set(contexts.map(entry => entry.path)) }, assess });
    const flags = [input.truncated.files.length && 'input-truncated', input.truncated.diff && 'diff-truncated', input.truncated.signals && 'signals-truncated', input.truncated.listed && 'lists-truncated'].filter(Boolean);
    const counts = { inputChars: input.chars, evidenceItems: input.items.length, filesShown: input.shown.size, filesTruncated: input.truncated.files.length, docs: validated.accepted.docs.length, context: validated.accepted.context.length, capture: validated.accepted.capture.length, dropped: Object.values(validated.dropped).reduce((sum, count) => sum + count, 0), flagged: validated.flagged };
    // What was kept and dropped stays with the attempt, beside the prompt and the provider's own trace.
    atomicJSON(join(artifactDir, 'upkeep-assessment.json'), { version: 1, flowId, mergeCommit: run.mergeCommit, mode: settings.mode, accepted: validated.accepted, dropped: validated.dropped, flagged: validated.flagged, abstention: validated.abstention, truncated: input.truncated });
    // propose (slice 5 part B): the docs candidates the validator kept travel in the result, with the
    // blob of their file at the merge commit; the run's settlement records them and may create a
    // follow-up (operations/upkeep-tasks.mjs). Slice 6: governing-context proposals travel the same
    // way, with their file's blob and the configured entries that reach it at the merge commit; only
    // the operator accepts them. Slice 7: the capture candidate travels too. A rule anchored to a
    // governing entry carries the file that entry reaches here, its blob and every entry that
    // reaches it, as a proposal does; a check or a learning is read against the target head when a
    // person accepts it.
    const outcome = assessmentOutcome(validated), proposing = settings.mode === 'propose', contextOf = path => contexts.find(entry => entry.path === path);
    const ruleFile = candidate => { const id = candidate.kind === 'rule' && candidate.anchor.startsWith('context:') ? candidate.anchor.slice(8) : null, entry = id ? contexts.find(row => row.ids.includes(id)) : null; return entry ? { file: entry.path, blob: entry.blob, entries: [...entry.ids] } : {}; };
    const proposed = proposing ? { docs: validated.accepted.docs.map(candidate => ({ ...candidate, blob: blobs.get(candidate.file) ?? null })), context: validated.accepted.context.map(candidate => ({ ...candidate, blob: contextOf(candidate.file)?.blob ?? null, entries: [...(contextOf(candidate.file)?.ids ?? [])] })), capture: validated.accepted.capture.map(candidate => ({ ...candidate, ...ruleFile(candidate) })) } : null;
    return { report: { ...outcome, ...(proposing && outcome.reason === 'observed' ? { reason: 'proposed' } : {}), flags, counts, dropped: validated.dropped }, invocations: [invocationRecord(observation)], modelRun: { day: reserved.day }, ...(proposed ? { proposed } : {}) };
  } catch (error) {
    const invocations = invoked ? [invocationRecord(observation ?? error.accountingResult ?? { provider: route.provider, model: route.model })] : [];
    // The provider process ended and returned no usable result: for this read-only step that is a
    // known end, a failure. It wrote nothing, so there is nothing to reconcile. Only an end that is
    // not known (a timeout, a cancellation, a transport failure, a usage limit) stays uncertain.
    if (error.code === 'INVALID_RESULT') throw Object.assign(new Error(`the upkeep model call ended without a usable result: ${error.message}`), { code: 'UPKEEP_INVALID_RESULT', providerInvocations: invocations });
    throw errorWith(error, invocations);
  } finally {
    // A step killed before this point leaves the checkout registered, as a killed target.sync does.
    try { await git(['worktree', 'remove', '--force', checkout]); } catch { /* nothing more can be done from here */ }
  }
}

// `now` is the clock; it is read where a time is needed, never once for the whole step.
export async function runUpkeepAssessment(intent, { runGit, providerInvoke = invoke, signal, deadlineAt, now = Date.now } = {}) {
  const action = intent.action, root = intent.projectRoot ?? intent.cwd, flowId = action.jobPayload?.flowId;
  const store = new Store(action.stateDir);
  try {
    const run = flowId ? upkeepRun(store, flowId) : null, config = store.meta('config', {});
    if (!run || run.status !== 'running') throw new Error(`no running upkeep run for flow ${flowId}`);
    if (upkeepMode(config) === 'off') return report('abstained', 'mode-off', 'start');
    // A run never starts its assessment after its deadline (5.3).
    if (run.runBy && now() >= Date.parse(run.runBy)) return report('abstained', 'stale-run', 'start');
    if (upkeepSuspended(store, 'all')) return report('abstained', 'suspended', 'start');
    const retrospective = store.get('retrospective', flowId);
    if (!retrospective) return report('abstained', 'no-retrospective', 'start');
    const signals = Array.isArray(retrospective.lessonSignals) ? retrospective.lessonSignals : [];
    const settings = upkeepSettings(config), remote = config.repository?.remote ?? 'origin';

    // The merge commit and the base it is compared with.
    let objects = new VerifiedObjects(root);
    const held = id => OBJECT.test(id ?? '') && objects.read([id])[0]?.type === 'commit';
    if (!held(run.mergeCommit) && run.target && runGit) {
      await runGit(['fetch', '--no-tags', remote, run.target], { cwd: root, env: process.env, timeoutMs: 60000 });
      objects = new VerifiedObjects(root);
    }
    if (!held(run.mergeCommit)) return report('abstained', 'merge-commit-unavailable', 'pre-filter');
    const merged = objects.commit(run.mergeCommit), base = held(run.base) ? run.base : merged.parents.find(held) ?? null;
    if (!base) return report('abstained', 'merge-commit-unavailable', 'pre-filter');
    const { touched, truncated: touchedTruncated } = comparedTrees(objects, objects.commit(base).tree, merged.tree);

    // 6.1: the docs set and the governing files of the merge commit's tree.
    const view = treeView(gitTreeLookup(objects, merged.tree), config.context), owned = upgradeOwned(root);
    const listed = listedFiles(objects, merged.tree, settings.docs.include);
    const classified = classifyDocs({ files: [...listed.files.keys()], docs: settings.docs, view, owned, learningsDir: learningsSettings(config).dir });
    const contexts = contextFiles({ context: config.context, view, owned }).map(entry => ({ ...entry, blob: blobAt(view.lookup, entry.path) })).filter(entry => entry.blob);

    // 6.2: one search of those files for the touched paths.
    const wanted = [...classified.docs.map(path => [path, listed.files.get(path)]), ...contexts.map(entry => [entry.path, entry.blob])];
    const read = wanted.slice(0, UPKEEP_SCAN_LIMITS.filesRead), blobs = new Map(read);
    objects.read([...new Set(read.map(([, id]) => id))]);
    const texts = new Map(); const text = path => { if (!texts.has(path)) texts.set(path, blobs.has(path) ? textOf(objects.blob(blobs.get(path))) : undefined); return texts.get(path); };
    const found = candidateFiles({ docs: classified.docs, contexts, map: settings.docs.map, touched, text });
    const decision = prefilterDecision({ ...found, governingUnresolvable: classified.governingUnresolvable, learningsUnresolvable: classified.learningsUnresolvable === true, docsDeclared: settings.docs.include.length > 0, signals,
      suspended: part => Boolean(upkeepSuspended(store, part)), docsWaiting: upkeepOpen(store).candidates.docs, maxWaiting: settings.docs.maxWaiting });
    if (touchedTruncated || listed.truncated || wanted.length > read.length) decision.flags.push('docs-scan-truncated');
    const { assess, ...recorded } = decision, counts = { ...recorded.counts, touchedPaths: touched.length, docsFiles: classified.docs.length, filesRead: read.length };
    if (!assess) return { route: 'pass', providerInvocations: [], upkeepRun: { ...recorded, counts, mergeCommit: run.mergeCommit, base } };
    // Something to assess: the model stage decides the outcome. The pre-filter's flags and counts stay.
    const { report: assessed, invocations = [], modelRun, proposed } = await assessWithModel({ intent, store, run, config, settings, objects, touched, classified, contexts, found, assess, signals, text, blobs, flowId, runGit, providerInvoke, signal, deadlineAt, now });
    return { route: 'pass', providerInvocations: invocations, ...(modelRun ? { modelRun } : {}), ...(proposed ? { proposed } : {}), upkeepRun: { ...assessed, flags: [...recorded.flags, ...(assessed.flags ?? [])], counts: { ...counts, ...(assessed.counts ?? {}) }, mergeCommit: run.mergeCommit, base, assess } };
  } catch (error) {
    // The result of an upkeep attempt always names its invocations: none, when it failed before a model started.
    throw errorWith(error, []);
  } finally { store.close(); }
}
