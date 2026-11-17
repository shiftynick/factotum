// Knowledge upkeep: classification and the deterministic pre-filter (knowledge-upkeep design,
// 6.1 and 6.2). Pure functions over what the assessment read from one commit: no Git, no store, no
// clock. workflows/upkeep-assess.mjs supplies the tree and the file texts.
import { globToRegExp, matchesGlob } from '../core/globs.mjs';
import { governingInTree, resolveTreePath } from '../core/tree-paths.mjs';
import { contextPathMatches as contextMatches } from './context.mjs';

// ---- Globs ----
// core/globs.mjs: `*` and `?` stay inside one path segment; `**` crosses segments, and `**/` also
// matches no directory at all, so docs/**/*.md covers docs/a.md and docs/guide/a.md. Matching is
// exact in letter case. (A context entry's own `paths` are matched as the context loader matches them.)
export { globToRegExp, matchesGlob };
// The directories a glob can match inside: its leading segments without a wildcard, as a prefix
// that ends in '/', or '' for the repository root. Used to keep the tree walk to those folders.
export function globDirectory(glob) {
  const parts = glob.split('/'), literal = [];
  for (const part of parts.slice(0, -1)) { if (/[*?]/.test(part)) break; literal.push(part); }
  return literal.length ? `${literal.join('/')}/` : '';
}
export const mayHoldMatch = (globs, directory) => globs.some(glob => { const prefix = globDirectory(glob); return prefix.startsWith(directory) || directory.startsWith(prefix); });

// ---- Upgrade-owned paths ----
// Compared without regard to case, as the upgrade-owned check on a candidate compares them.
export function upgradeOwnedPath(owned, path) {
  const lower = path.toLowerCase();
  return lower === String(owned?.lock ?? '').toLowerCase() || (owned?.files ?? []).some(file => file.toLowerCase() === lower) || (owned?.dirs ?? []).some(dir => lower.startsWith(dir.toLowerCase()));
}
const inDirectory = (directory, path) => Boolean(directory) && path.toLowerCase().startsWith(`${directory.toLowerCase().replace(/\/+$/, '')}/`);

// ---- 6.1 Classification ----
// The docs set of a tree: the regular files the project declared (`include` less `exclude`), less,
// in this order, every governing path as 7.1 resolves it, upgrade-owned paths and the learnings
// directory. A file in both `include` and `context.files` is a context file and only that. When a
// governing entry cannot be resolved in the tree, nothing can be shown to be outside the protected
// set: there is no docs set, and the caller records `governing-unresolvable`.
//   files: the repository-relative paths of the regular files of the tree that `include` may reach
//   view:  { lookup, protected } for that tree (core/tree-paths.mjs treeView)
//   learningsDir: the configured learnings directory, as written. It is resolved in the tree like a
//          governing path, so a directory reached through a link is subtracted where it really is;
//          one the tree cannot place leaves no docs set either (`learningsUnresolvable`).
export function classifyDocs({ files, docs, view, owned, learningsDir }) {
  const declared = files.filter(path => docs.include.some(glob => matchesGlob(glob, path)) && !docs.exclude.some(glob => matchesGlob(glob, path)));
  if (!view.protected.complete) return { docs: [], declared: declared.length, governing: [], governingUnresolvable: true, unresolvable: view.protected.unresolvable };
  const learnings = learningsDir ? resolveTreePath(view.lookup, learningsDir) : null;
  if (learnings?.unresolvable) return { docs: [], declared: declared.length, governing: [], governingUnresolvable: false, learningsUnresolvable: true, unresolvable: [{ id: 'learnings.dir', path: learningsDir, reason: learnings.unresolvable }] };
  learningsDir = learnings?.path || null;
  const set = [], governing = [];
  for (const path of declared) {
    if (governingInTree(view.lookup, view.protected, path).governing) { governing.push(path); continue; }
    if (upgradeOwnedPath(owned, path) || inDirectory(learningsDir, path)) continue;
    set.push(path);
  }
  return { docs: set, declared: declared.length, governing, governingUnresolvable: false, unresolvable: [] };
}
// The context files that may be proposed against: each configured entry that reaches a regular
// file in the tree, by its resolved path, unless that file is upgrade-owned. Several entries may
// reach one file (the same path written twice, or through a link), each with its own `paths`: the
// file is listed once, with every entry's id and the union of their mappings, so the answer does
// not depend on the order of the entries.
export function contextFiles({ context, view, owned }) {
  const found = new Map();
  for (const entry of context?.files ?? []) {
    const at = governingInTree(view.lookup, view.protected, entry?.path);
    if (!at.protectedFile || upgradeOwnedPath(owned, at.path)) continue;
    const row = found.get(at.path) ?? { id: entry.id ?? null, ids: [], path: at.path, paths: [] };
    if (entry.id != null && !row.ids.includes(entry.id)) row.ids.push(entry.id);
    for (const pattern of Array.isArray(entry.paths) ? entry.paths : []) if (typeof pattern === 'string' && !row.paths.includes(pattern)) row.paths.push(pattern);
    found.set(at.path, row);
  }
  return [...found.values()];
}

// ---- 6.2 The pre-filter ----
// A file is a candidate when its text contains the repository-relative path of a file the merge
// touched, or when it is mapped to one: a doc by an `upkeep.docs.map` entry, a context entry by its
// own `paths`. A file the merge itself edited is a candidate only through a reference to a path
// the merge removed (a rename is a removal and an addition).
//   touched: [{ path, change: 'added' | 'modified' | 'deleted' }]
//   text:    path -> the file's text at the merge commit, or undefined when it was not read
const refers = (text, paths) => typeof text === 'string' && paths.some(path => text.includes(path));
export function candidateFiles({ docs, contexts, map, touched, text }) {
  const all = touched.map(row => row.path), removed = touched.filter(row => row.change === 'deleted').map(row => row.path), edited = new Set(all);
  const docCandidates = docs.filter(path => edited.has(path) ? refers(text(path), removed.filter(other => other !== path)) : refers(text(path), all) || map.some(row => matchesGlob(row.docs, path) && all.some(changed => row.paths.some(glob => matchesGlob(glob, changed)))));
  const contextCandidates = contexts.filter(entry => edited.has(entry.path) ? refers(text(entry.path), removed.filter(other => other !== entry.path)) : refers(text(entry.path), all) || all.some(changed => entry.paths.some(pattern => contextMatches(pattern, changed)))).map(entry => entry.path);
  return { docCandidates, contextCandidates };
}

// What the run does with what the pre-filter found. `signals` are the retrospective's lesson
// signals; `suspended(part)` and `docsWaiting`/`maxWaiting` come from the store. The answer is the
// run's outcome, its reason and its flags, and `assess` when a model call follows: the parts the
// model stage assesses (workflows/upkeep-assess.mjs), which then decides the outcome. The outcome
// given here with `assess` is what the run records when no model can be started at all.
export function prefilterDecision({ docCandidates, contextCandidates, governingUnresolvable, learningsUnresolvable = false, docsDeclared = true, signals = [], suspended = () => false, docsWaiting = 0, maxWaiting = 0 }) {
  const verified = signals.filter(signal => signal?.class === 'verified').length, weak = signals.filter(signal => signal?.class === 'weak').length, flags = [];
  if (governingUnresolvable) flags.push('governing-unresolvable');
  if (learningsUnresolvable) flags.push('learnings-unresolvable');
  if (!docsDeclared) flags.push('docs-not-declared');
  const counts = { docCandidates: docCandidates.length, contextCandidates: contextCandidates.length, verifiedSignals: verified, weakSignals: weak };
  const done = (outcome, reason, assess = null) => ({ outcome, reason, stage: 'pre-filter', flags: [...new Set(flags)], counts, assess });
  if (suspended('all')) return done('abstained', 'suspended');
  const files = docCandidates.length + contextCandidates.length;
  // Weak signals alone never cause a model call (N5), and no file with no signal is the usual "nothing".
  if (!files && !verified) {
    if (!weak) flags.push('no-signal');
    // With no docs set to look in, "no referring doc" would claim more than is known.
    if (governingUnresolvable) return done('abstained', 'governing-unresolvable');
    if (learningsUnresolvable) return done('abstained', 'learnings-unresolvable');
    return done('nothing', weak ? 'weak-signals-only' : 'no-referring-doc');
  }
  // Each part that has something to assess, unless it is suspended or its backlog is full.
  const backlogFull = docCandidates.length > 0 && docsWaiting >= maxWaiting;
  if (backlogFull) flags.push('backlog-full');
  for (const [part, has] of [['docs', docCandidates.length > 0], ['context', contextCandidates.length > 0], ['capture', verified > 0]]) if (has && suspended(part)) flags.push(`${part}-suspended`);
  const assess = { docs: docCandidates.length > 0 && !backlogFull && !suspended('docs'), context: contextCandidates.length > 0 && !suspended('context'), capture: verified > 0 && !suspended('capture') };
  if (!assess.docs && !assess.context && !assess.capture) return done('abstained', flags.some(flag => flag.endsWith('-suspended')) ? 'suspended' : 'backlog-full');
  if (suspended('model')) { flags.push('model-suspended'); return done('abstained', 'suspended'); }
  return done('abstained', 'assessment-unavailable', assess);
}
