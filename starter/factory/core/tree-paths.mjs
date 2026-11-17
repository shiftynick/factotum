// Resolving a path in a Git tree the way the file system would, and the set of governing paths
// that follows from it (knowledge-upkeep design, 7.1).
//
// Governing context is loaded through the file system's real path (operations/context.mjs), so a
// governing file may be reached through a symbolic link anywhere on its path, and so may a file
// that looks like an ordinary document. Comparing configured paths as written would let a
// governing file pass as a document. What is published and merged is a Git tree, so paths are
// resolved in a tree, never in a working directory.
//
// Resolution walks one component at a time and resolves each component before any `..` that
// follows it is applied. Nothing is normalised in advance, neither the path nor a link's target:
// cancelling `name/..` as text skips `name`, and `name` may be a link.
//
// A lookup is a function (directories, name) -> entry | null, where `directories` is a list of
// names already shown to be real directories from the repository root, and entry is one of
//   { type: 'directory' } | { type: 'file' } | { type: 'submodule' } | { type: 'link', target }
// Names are matched exactly, as the supported file system does. gitTreeLookup reads a tree through
// hash-verified objects (core/verified-git.mjs).
export const MAX_LINK_HOPS = 40;
const unresolvable = reason => ({ unresolvable: reason });

// The result is { path, exists, type?, hops } with `path` relative to the repository root ('' is
// the root itself), or { unresolvable: reason } when the tree cannot say where the path leads: it
// leaves the repository, passes a submodule, follows an absolute or unreadable link target, runs
// through more than MAX_LINK_HOPS links (which covers a cycle), or applies `..` after a
// component that does not exist. A path that does not exist, with no `..` after the missing
// component, resolves to where it would be, marked exists: false.
export function resolveTreePath(lookup, path) {
  if (typeof path !== 'string' || !path.length || path.includes('\0')) return unresolvable('not a path');
  // A repository path is relative. An absolute one names something outside the tree.
  if (path.startsWith('/')) return unresolvable('an absolute path');
  const resolved = [], pending = path.split('/'); let hops = 0;
  while (pending.length) {
    const name = pending.shift();
    if (name === '' || name === '.') continue;
    if (name === '..') { if (!resolved.length) return unresolvable('the path leaves the repository'); resolved.pop(); continue; }
    const entry = lookup(resolved, name);
    if (entry?.type === 'directory') { resolved.push(name); continue; }
    if (entry?.type === 'link') {
      if (++hops > MAX_LINK_HOPS) return unresolvable(`more than ${MAX_LINK_HOPS} symbolic links (a cycle)`);
      if (typeof entry.target !== 'string' || !entry.target.length || entry.target.includes('\0')) return unresolvable('a symbolic link whose target cannot be read');
      if (entry.target.startsWith('/')) return unresolvable('a symbolic link with an absolute target');
      // The target takes the link's place at the front, to be walked from the link's own directory
      // by these same rules; the resolved list is unchanged.
      pending.unshift(...entry.target.split('/'));
      continue;
    }
    if (entry?.type === 'submodule') return unresolvable('a submodule on the path');
    if (entry?.type === 'file' && !pending.length) return { path: [...resolved, name].join('/'), exists: true, type: 'file', hops };
    // Missing, or an ordinary file with components after it (treated as missing).
    const rest = pending.filter(part => part !== '' && part !== '.');
    if (rest.includes('..')) return unresolvable('`..` after a component that does not exist');
    return { path: [...resolved, name, ...rest].join('/'), exists: false, hops };
  }
  return { path: resolved.join('/'), exists: true, type: 'directory', hops };
}

// A lookup over one Git tree, read through verified objects. Each directory is read once.
export function gitTreeLookup(objects, rootTree) {
  const directories = new Map();
  const read = treeId => new Map(objects.tree(treeId).map(entry => [entry.name, entry]));
  const directory = names => {
    const key = names.join('/'); if (directories.has(key)) return directories.get(key);
    let entries = null;
    if (!names.length) entries = read(rootTree);
    else { const entry = directory(names.slice(0, -1))?.get(names.at(-1)); if (entry?.mode === '40000') entries = read(entry.id); }
    directories.set(key, entries); return entries;
  };
  return (names, name) => {
    const entry = directory(names)?.get(name); if (!entry) return null;
    if (entry.mode === '40000') return { type: 'directory', id: entry.id };
    if (entry.mode === '160000') return { type: 'submodule', id: entry.id };
    if (entry.mode !== '120000') return { type: 'file', id: entry.id, mode: entry.mode };
    // A link's target is the blob's bytes. One that is not valid UTF-8 cannot be walked.
    const body = objects.blob(entry.id), target = body.toString('utf8');
    return { type: 'link', id: entry.id, target: Buffer.from(target, 'utf8').equals(body) ? target : null };
  };
}
export const gitCommitLookup = (objects, commitId) => gitTreeLookup(objects, objects.commit(commitId).tree);

// Resolved paths are compared without regard to case, which is the conservative direction and
// how the upgrade-owned check compares paths (core/verified-git.mjs identity). No Unicode
// normalisation is applied.
export const comparablePath = path => path.toLowerCase();

// The protected set of a tree under a configuration: the resolved path of every context.files
// entry, including entries whose file does not exist. `unresolvable` lists the entries the tree
// cannot place; when there is one, nothing in that tree can be shown to be outside the set.
// `files` holds, exactly as resolved, the paths at which an entry reaches a regular file in this
// tree: the files the context loader would deliver. An entry that resolves to nothing, to a
// directory, or to a file only under another letter case protects its path but delivers no file.
export function protectedSet(lookup, context) {
  const paths = new Set(), files = new Set(), unresolvableEntries = [];
  for (const entry of context?.files ?? []) {
    const found = resolveTreePath(lookup, entry?.path);
    if (found.unresolvable) { unresolvableEntries.push({ id: entry?.id ?? null, path: entry?.path ?? null, reason: found.unresolvable }); continue; }
    paths.add(comparablePath(found.path));
    if (found.exists && found.type === 'file') files.add(found.path);
  }
  return { paths, files, unresolvable: unresolvableEntries, complete: unresolvableEntries.length === 0 };
}

// Whether a path is governing in a tree: its resolved path is in the tree's protected set, or it
// cannot be resolved, or a governing entry of that tree cannot be (fail closed). That answer is
// the conservative one: a protected path that does not exist, or is a directory, is governing.
// `protectedFile` is the strict answer a context task needs, and errs the other way: the path
// resolves to a regular file in this tree, and a governing entry reaches that same file. A
// missing path, a directory, a file followed by `/`, and a file the entry names only in another
// letter case are governing but not a protected file: the context loader delivers none of them.
export function governingInTree(lookup, protectedPaths, path) {
  if (!protectedPaths.complete) return { governing: true, protectedFile: false, reason: 'governing-unresolvable', entries: protectedPaths.unresolvable };
  const found = resolveTreePath(lookup, path);
  if (found.unresolvable) return { governing: true, protectedFile: false, reason: 'unresolvable', detail: found.unresolvable };
  if (!protectedPaths.paths.has(comparablePath(found.path))) return { governing: false, protectedFile: false, path: found.path };
  return { governing: true, protectedFile: found.exists === true && found.type === 'file' && protectedPaths.files.has(found.path), reason: 'protected', path: found.path };
}
// One tree with its protected set, and the question asked of two trees at once. The comparison
// tree shows what a path is today, the candidate's tree what it would be after the merge; a
// changed path that is governing in either is refused for every task kind but one, which
// requires it to be a protected file in both.
export const treeView = (lookup, context) => ({ lookup, protected: protectedSet(lookup, context) });
export function governingAcross(views, path) {
  const results = views.map(view => governingInTree(view.lookup, view.protected, path));
  return { either: results.some(row => row.governing), both: results.every(row => row.protectedFile), results };
}
