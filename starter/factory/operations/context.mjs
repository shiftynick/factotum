import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { assert, digest } from '../core/contracts.mjs';
function matches(pattern, path) { const escaped = pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'); return new RegExp(`^${escaped}$`).test(path); }
// How a context entry's own `paths` select it; knowledge upkeep's pre-filter matches them the same way.
export const contextPathMatches = matches;
const MAPPING_OMITTED = 'path mapping did not match';
// A governing file is the file the kernel reaches from the configured path: realpath(3) on the
// path exactly as written, under the real root. Neither path.resolve nor Node's own realpathSync is
// used, because both cancel `name/..` as text, in the path and in a symbolic link's target, and
// `name` may be a link: the kernel follows it first. core/tree-paths.mjs resolves the same way in a
// Git tree, so what is protected there is what is delivered here.
function readEntry(root, entry) {
  assert(typeof entry.path === 'string' && entry.path.length > 0 && !entry.path.includes('\0'), 'context path required');
  const path = realpathSync.native(isAbsolute(entry.path) ? entry.path : `${root}/${entry.path}`), rel = relative(root, path);
  assert(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'context must stay inside project root');
  assert(statSync(path).isFile(), 'context must be a regular file');
  return readFileSync(path, 'utf8');
}
// `snapshot` ({ ids, read(entry) }, operations/governance-edit.mjs) reads the entries a task is
// approved to edit from the approved snapshot instead of the working checkout, where the
// candidate's version of them is a proposal.
export function assembleContext({ repoRoot, config, changedPaths = [], snapshot = null }) {
  assert(Number.isSafeInteger(config.maxChars) && config.maxChars > 0, 'context budget required');
  const root = realpathSync(repoRoot), files = [], omitted = [], ids = new Set(), entries = {}; let used = 0;
  const read = entry => snapshot?.ids.has(entry.id) ? snapshot.read(entry) : readEntry(root, entry);
  // Required excerpts have priority; no silent truncation.
  for (const entry of [...config.files].sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)))) {
    assert(entry.id && !ids.has(entry.id), 'unique context IDs required'); ids.add(entry.id);
    // Every configured entry's definition and contents, selected or not: the snapshot a reviewed
    // plan keeps so a file its own scope selects later can be shown to be unchanged since planning.
    const definition = digest({ path: entry.path, paths: entry.paths ?? null, required: Boolean(entry.required) });
    if (entry.paths?.length && !changedPaths.some(p => entry.paths.some(pattern => matches(pattern, p)))) {
      if (entry.required) throw new Error(`required context mapping has no match: ${entry.id}`);
      let unselected = null; try { unselected = digest(read(entry)); } catch {}
      entries[entry.id] = { definition, digest: unselected }; omitted.push({ id: entry.id, reason: MAPPING_OMITTED }); continue;
    }
    let text;
    try { text = read(entry); }
    catch (error) { if (entry.required) throw new Error(`required context unavailable: ${entry.id}: ${error.message}`); entries[entry.id] = { definition, digest: null }; omitted.push({ id: entry.id, reason: 'unavailable or outside project' }); continue; }
    entries[entry.id] = { definition, digest: digest(text) };
    if (used + text.length > config.maxChars) { assert(!entry.required, `required context exceeds budget: ${entry.id}`); omitted.push({ id: entry.id, reason: 'budget exhausted' }); continue; }
    files.push({ id: entry.id, path: entry.path, text, digest: digest(text), required: Boolean(entry.required) }); used += text.length;
  }
  // An entry a task is approved to change is always delivered; anything else fails closed.
  for (const id of snapshot?.ids ?? []) assert(files.some(file => file.id === id), `governing context ${id}, which this task is approved to change, is not delivered (${omitted.find(row => row.id === id)?.reason ?? 'not configured'}); every such entry is delivered whole, so raise context.maxChars or change the configuration`);
  // entries stays outside the package digest: it is planning evidence, not delivered context.
  return { version: 1, files, omitted, chars: used, digest: digest({ files, omitted }), entries };
}
// What a plan records about the governing context it was made under.
export function contextManifest(context) {
  if (!context?.entries) return undefined;
  return { digest: context.digest, files: context.files.map(({ id, path, digest }) => ({ id, path, digest })), omitted: context.omitted.map(({ id, reason }) => ({ id, reason })), entries: context.entries };
}
// A reviewed plan fixes its governing context. A later step may receive an additional
// path-mapped file only when the plan's own scope (task paths and planned files) selects it
// and its mapping and contents are exactly those recorded at planning. Any other difference,
// including an edit to a governing file or any changed entry definition, is returned as
// { reason, remedy }: remedy 'replan', or 'budget' when only a larger context.maxChars helps.
export function governingContextChange({ planned, current, config, scope }) {
  const state = (context, id) => context.files.find(f => f.id === id) ?? context.omitted.find(o => o.id === id);
  const ids = context => [...context.files, ...context.omitted].map(row => row.id).sort();
  // `entry` names a governing file whose contents or delivery changed (not its mapping), so the
  // caller can say which tasks may change it.
  const replan = (reason, entry) => ({ reason, remedy: 'replan', ...(entry ? { entry } : {}) });
  if (digest(ids(planned)) !== digest(ids(current))) return replan('context configuration entries changed since the reviewed plan');
  for (const id of ids(current)) {
    const before = state(planned, id), after = state(current, id);
    // Every entry's definition is part of the reviewed governing context, delivered or not.
    const recorded = planned.entries?.[id], now = current.entries?.[id];
    if (!recorded || !now || recorded.definition !== now.definition) return replan(`context mapping for ${id} changed since the reviewed plan`);
    if (!before.reason) {
      if (after.reason === 'budget exhausted') return { reason: `governing context ${id} is no longer delivered (budget exhausted by newly selected context)`, remedy: 'budget' };
      if (after.reason || after.path !== before.path || after.digest !== before.digest) return replan(`governing context ${id} changed or is no longer delivered since the reviewed plan`, id);
      continue;
    }
    if (after.reason === before.reason) continue;
    if (before.reason !== MAPPING_OMITTED) return replan(`governing context ${id} changed since the reviewed plan`, id);
    if (recorded.digest !== now.digest) return replan(`governing context ${id} changed since the reviewed plan`, id);
    const entry = config.files.find(f => f.id === id);
    if (!entry?.paths?.some(pattern => scope.some(p => typeof p === 'string' && matches(pattern, p)))) return replan(`governing context ${id} was selected by changes outside the reviewed plan`);
    if (after.reason === 'budget exhausted') return { reason: `governing context ${id} selected by the reviewed plan is not delivered (budget exhausted)`, remedy: 'budget' };
  }
  return null;
}
// The guard message for a governing context change; budget exhaustion is not a replan problem.
export function governingContextMessage(change, prefix) {
  return change.remedy === 'budget' ? `${prefix}: ${change.reason}; increase context.maxChars, replanning does not change the budget` : `${prefix}; replan required: ${change.reason}`;
}
export function contextDelivery(store, { consumerId, context }) {
  return store.tx(() => {
    const old = store.get('contextDelivery', consumerId), deliver = context.files.filter(f => old?.digests?.[f.id] !== f.digest);
    // This records a prepared package, not worker acknowledgment. Caller acknowledges only after confirmed delivery.
    return { consumerId, contextDigest: context.digest, files: deliver, omitted: context.omitted };
  });
}
export function acknowledgeContext(store, { consumerId, context }) { return store.tx(() => store.put('contextDelivery', { id: consumerId, digest: context.digest, digests: Object.fromEntries(context.files.map(f => [f.id, f.digest])) })); }
