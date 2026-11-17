// Knowledge upkeep: the limits of an upkeep task, enforced on the exact candidate (knowledge-upkeep
// design, 7.4; slice 5 part A). This release enforces the `docs` kind; since slice 6 the `context`
// kind, the one kind that may change a governing file, and that may change nothing else; and since
// slice 7 the `check` kind (existing fast-check scripts only, modes kept) and the `learning-add`
// kind (exactly one new learning file, written exactly as accepted); since slice 8 the
// `learning-retire` kind (exactly one learning file deleted, with exactly its pinned content).
//
// The check runs inside workspace.commit, workspace.integrate, forge.publish and forge.merge
// (workflows/dispatch.mjs), so no graph can route around it: a graph without a commit step still
// passes publication, which is decisive, and merge. What is compared is the candidate head's tree
// against the comparison commit's tree, entry by entry, read through hash-verified objects
// (core/verified-git.mjs), never through `git diff` under the repository's configuration,
// attributes or filters. The comparison commit is the commit the factory prepared the workspace
// from before an integration, and the integrated target commit after one, which the candidate must
// contain through verified parents.
//
// The candidate's own commits (those not reachable from the comparison commit) are judged too, so a
// change a builder committed and later undid is refused like one it left in place: its paths and
// entries by every rule, and every blob it wrote by the content rule.
//
// Tree entry names are read exactly. A name that is not valid UTF-8, or that two entries of one
// tree share once decoded, would let two different Git paths read as one, so any tree the check
// reads that holds one refuses the candidate.
import { spawnSync } from 'node:child_process';
import { VerifiedObjects, NO_HISTORY_REWRITES_ARGS, NO_HISTORY_REWRITES_ENV, assertNoHistoryRewrites } from '../core/verified-git.mjs';
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS } from '../core/git-options.mjs';
import { gitTreeLookup, governingAcross, resolveTreePath, treeView } from '../core/tree-paths.mjs';
import { learningsSettings, upkeepSettings } from '../core/upkeep-config.mjs';
import { CHECK_MARKER_MAX_FILES, CHECK_MAX_CHANGED_LINES, CHECK_SCRIPT_MODES, checkApprovalRefusal, checkScriptsApproved, CONTEXT_LINES_PER_PROPOSAL, LEARNING_MAX_CHARS, hasUpkeepMarker, learningChars, markerProblems, parseLearning, renderLearning } from '../core/upkeep-namespace.mjs';
import { collapseWhitespace } from '../operations/upkeep-class-key.mjs';
import { MAX_RESOLVED_WORDS, NAMED_ELSEWHERE, scriptsByPath, scriptsNamedElsewhere } from '../operations/upkeep-capture.mjs';
import { changedLinesExact } from '../core/line-diff.mjs';
import { upgradeOwned } from '../core/install-layout.mjs';
import { matchesGlob, upgradeOwnedPath } from '../operations/upkeep-prefilter.mjs';

// A changed blob larger than this, containing a NUL byte or not valid UTF-8 is binary (7.4).
export const MAX_TEXT_BYTES = 1024 * 1024;
// How many changed entries one comparison reads before it stops and refuses. A docs task may change
// three files; a candidate with more changes than this is refused without reading the rest.
export const MAX_COMPARED_CHANGES = 200;
// The content rule reads at most this many blobs, and this many bytes in all, for one check (the
// candidate's changed files and every blob its own commits wrote). Past either bound the candidate
// is refused: what was not read cannot be shown to be text.
export const MAX_CONTENT_BLOBS = 1000, MAX_CONTENT_BYTES = 32 * MAX_TEXT_BYTES;
const REGULAR = '100644', DIRECTORY = '40000', LINK = '120000', SUBMODULE = '160000';
// The kinds this check enforces.
export const CHECKED_KINDS = Object.freeze(['docs', 'context', 'check', 'learning-add', 'learning-retire']);
const OBJECT_ID = /^([a-f\d]{40}|[a-f\d]{64})$/i;

export class UpkeepCandidateRefusal extends Error {
  constructor(message, violations) { super(message); this.name = 'UpkeepCandidateRefusal'; this.upkeepViolations = violations; }
}

// ---- Exact tree names ----
export class InvalidTreeName extends Error { constructor(message) { super(message); this.name = 'InvalidTreeName'; } }
const strictText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// A reader with the verified reader's tree(), blob() and commit(), whose tree() refuses (throws
// InvalidTreeName) a tree with an entry name that is not valid UTF-8, contains a slash, is empty,
// `.` or `..`, or that another entry of the same tree also has. Names are decoded without dropping
// a byte order mark, so every name it returns stands for exactly one byte string.
export function strictTreeReader(objects) {
  const checked = new Map();
  return {
    blob: id => objects.blob(id), commit: id => objects.commit(id),
    tree(id) {
      if (checked.has(id)) return checked.get(id);
      const body = objects.need(id, 'tree'), raw = id.length / 2, names = new Set();
      for (let at = 0; at < body.length;) {
        const space = body.indexOf(32, at), nul = space < 0 ? -1 : body.indexOf(0, space);
        if (space < 0 || nul < 0) throw new InvalidTreeName(`tree ${id.slice(0, 12)} is malformed`);
        const bytes = body.subarray(space + 1, nul); let name;
        try { name = strictText.decode(bytes); } catch { throw new InvalidTreeName(`an entry name in tree ${id.slice(0, 12)} is not valid UTF-8 (bytes ${bytes.toString('hex').slice(0, 80)})`); }
        if (!name.length || name === '.' || name === '..' || name.includes('/')) throw new InvalidTreeName(`tree ${id.slice(0, 12)} holds an entry named ${JSON.stringify(name)}, which is not a single path component`);
        if (names.has(name)) throw new InvalidTreeName(`tree ${id.slice(0, 12)} holds two entries named ${JSON.stringify(name)}`);
        names.add(name); at = nul + 1 + raw;
      }
      const entries = objects.tree(id);
      if (entries.length !== names.size || entries.some(entry => !names.has(entry.name))) throw new InvalidTreeName(`the entry names of tree ${id.slice(0, 12)} cannot be read exactly`);
      checked.set(id, entries); return entries;
    },
  };
}

// ---- Tree comparison through verified objects ----
// Every entry that differs between two trees ([{ path, before, after }], each side { mode, id } or
// null), exact in name and letter case: a path that differs from another only by case is an
// addition and a removal. A folder on one side and anything else on the other is the folder's whole
// content removed (or added) and the other entry added (or removed). `null` is the empty tree.
// Reading stops after `limit` entries; `complete` then says the list is not the whole difference.
export function treeChanges(objects, beforeTree, afterTree, { limit = MAX_COMPARED_CHANGES } = {}) {
  const changes = []; let complete = true;
  const read = id => id ? new Map(objects.tree(id).map(entry => [entry.name, entry])) : new Map();
  const push = row => { if (changes.length >= limit) { complete = false; return false; } changes.push(row); return true; };
  const everything = (treeId, prefix, side) => {
    for (const entry of objects.tree(treeId)) {
      if (!complete) return;
      const path = `${prefix}${entry.name}`;
      if (entry.mode === DIRECTORY) everything(entry.id, `${path}/`, side);
      else push({ path, before: side === 'before' ? { mode: entry.mode, id: entry.id } : null, after: side === 'after' ? { mode: entry.mode, id: entry.id } : null });
    }
  };
  const walk = (left, right, prefix) => {
    if (left === right) return;
    const a = read(left), b = read(right), names = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const name of names) {
      if (!complete) return;
      const x = a.get(name), y = b.get(name), path = `${prefix}${name}`;
      if (x && y && x.mode === y.mode && x.id === y.id) continue;
      if (x?.mode === DIRECTORY && y?.mode === DIRECTORY) { walk(x.id, y.id, `${path}/`); continue; }
      if (x?.mode === DIRECTORY) everything(x.id, `${path}/`, 'before');
      if (y?.mode === DIRECTORY) everything(y.id, `${path}/`, 'after');
      const before = x && x.mode !== DIRECTORY ? { mode: x.mode, id: x.id } : null, after = y && y.mode !== DIRECTORY ? { mode: y.mode, id: y.id } : null;
      if (before || after) push({ path, before, after });
    }
  };
  walk(beforeTree, afterTree, '');
  return { changes, complete };
}

// The entry at a path in a tree, looked up name by name and exactly, without following links; null
// when the path does not exist there. Directories above it are reported by `above`.
function entryAt(objects, rootTree, path) {
  const parts = path.split('/'); let tree = rootTree; const above = [];
  for (const [index, name] of parts.entries()) {
    const entry = objects.tree(tree).find(row => row.name === name);
    if (!entry) return { entry: null, above };
    if (index === parts.length - 1) return { entry, above };
    above.push({ path: parts.slice(0, index + 1).join('/'), mode: entry.mode });
    if (entry.mode !== DIRECTORY) return { entry: null, above };
    tree = entry.id;
  }
  return { entry: null, above };
}

// The candidate's own commits and what each changed: a commit changes a path when its entry there
// differs from every parent's (so the factory's merge of the target, which takes the target's
// side, changes nothing). Each commit reported is shown, through verified parents, to be outside
// the comparison commit's history.
function ownCommitChanges(objects, reader, head, comparison, limit) {
  const own = objects.ownCommits(head, [comparison]), rows = []; let complete = true;
  for (const id of own) {
    const commit = objects.commits.get(id);
    if (!commit) throw new Error(`commit ${id.slice(0, 12)} of the candidate's own history cannot be read; it cannot be checked`);
    const parents = commit.parents.map(parent => { if (!objects.commits.has(parent)) objects.loadCommits([parent]); const found = objects.commits.get(parent); if (!found) throw new Error(`commit ${id.slice(0, 12)} has a parent ${parent.slice(0, 12)} that cannot be read; the candidate's own history cannot be checked`); return found; });
    const lists = (parents.length ? parents.map(parent => parent.tree) : [null]).map(tree => treeChanges(reader, tree, commit.tree, { limit }));
    if (lists.some(list => !list.complete)) complete = false;
    const [first, ...rest] = lists.map(list => new Map(list.changes.map(row => [row.path, row])));
    for (const [path, row] of first) if (rest.every(other => other.has(path))) rows.push({ commit: id, path, after: row.after, befores: [row.before, ...rest.map(other => other.get(path).before)] });
  }
  if (!rows.length) return { rows, complete };
  const suspects = new Set(rows.map(row => row.commit)), trusted = objects.walk([comparison], { done: seen => [...suspects].every(commit => seen.has(commit)) });
  return { rows: rows.filter(row => !trusted.has(row.commit)), complete };
}

// ---- Content ----
// A byte order mark is kept in the text, so adding or removing one is a changed line.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), ...NO_HISTORY_REWRITES_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
// Object sizes as the object store reports them, read before any blob is: a blob reported larger
// than the text limit is refused without being read. A size reported smaller than the content is
// caught when the blob is read and hash-verified (its length is part of its id).
function objectSizes(repository, ids) {
  if (!ids.length) return new Map();
  const result = spawnSync('git', [...NO_AUTO_MAINTENANCE, ...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...NO_HISTORY_REWRITES_ARGS, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { cwd: repository, env: gitEnv(), input: ids.join('\n') + '\n', maxBuffer: 1 << 24, timeout: 300000 });
  if (result.status !== 0) throw new Error(`git cat-file failed while checking blob sizes: ${String(result.stderr ?? result.error?.message ?? '').trim().slice(0, 300)}`);
  const sizes = new Map();
  for (const line of result.stdout.toString('utf8').split('\n').filter(Boolean)) { const [id, type, size] = line.split(' '); if (type === 'blob' && /^\d+$/.test(size ?? '')) sizes.set(id, Number(size)); }
  return sizes;
}
// Why each blob is not text a docs task may change, or its text. Bounded: at most MAX_CONTENT_BLOBS
// blobs and MAX_CONTENT_BYTES bytes are read per check; a blob past either bound is `exhausted`,
// which refuses the candidate.
function contentReader(objects) {
  const verdicts = new Map(); let blobs = 0, bytes = 0;
  const judge = id => {
    const body = objects.blob(id);
    if (body.length > MAX_TEXT_BYTES) return { binary: `it is larger than 1 MiB (${body.length} bytes)` };
    if (body.includes(0)) return { binary: 'it contains a NUL byte' };
    try { return { text: decoder.decode(body) }; } catch { return { binary: 'it is not valid UTF-8 text' }; }
  };
  return ids => {
    const unknown = [...new Set(ids)].filter(id => !verdicts.has(id)), sizes = objectSizes(objects.cwd, unknown);
    for (const id of unknown) {
      const size = sizes.get(id);
      if (size === undefined) { verdicts.set(id, { binary: 'its size cannot be read' }); continue; }
      if (size > MAX_TEXT_BYTES) { verdicts.set(id, { binary: `it is larger than 1 MiB (${size} bytes)` }); continue; }
      if (blobs + 1 > MAX_CONTENT_BLOBS || bytes + size > MAX_CONTENT_BYTES) { verdicts.set(id, { exhausted: true }); continue; }
      blobs++; bytes += size; verdicts.set(id, judge(id));
    }
    return new Map(ids.map(id => [id, verdicts.get(id)]));
  };
}
const isBlob = side => Boolean(side) && side.mode !== LINK && side.mode !== SUBMODULE && side.mode !== DIRECTORY;

const lowerInside = (directory, path) => Boolean(directory) && path.toLowerCase().startsWith(`${directory.toLowerCase().replace(/\/+$/, '')}/`);

// ---- The docs, context, check and learning-add kinds ----
// Every rule the candidate breaks: [{ code, path?, commit?, detail }]. Pure apart from the reads
// through `objects`. `owned` is the upgrade-owned set (core/install-layout.mjs upgradeOwned).
// The kinds share every rule of 7.4's first table and the matrix's rows for links, upgrade-owned
// paths and binary content; they differ in which paths may change, additions, modes, the learnings
// directory and the budget:
//   docs          each changed path is in the docs set and governing in neither tree; no addition
//                 or deletion; ordinary files; 3 files, 40 lines
//   context       each changed path is a governing file in both trees (the loader would deliver
//                 it), reached by exactly the context entries the marker names for it, each a
//                 required, unmapped entry; the files the proposals name, and 12 changed lines per
//                 proposal. An accepted rule's text is in its file afterwards
//   check         each changed path is a declared file that is still, under the configuration at
//                 this operation, the script of a configured fast check and used by nothing else;
//                 governing in neither tree, never in the learnings directory; no addition or
//                 deletion; an ordinary or executable file whose mode never changes and is the mode
//                 it was offered at; 2 files, 80 lines
//   learning-add  exactly one change: the declared file added, directly inside the learnings
//                 directory as it resolves in both trees, ordinary and not executable, and written
//                 exactly as accepted (the frontmatter schema, the marker's id, paths and every
//                 other field, the accepted text), at most 1,500 characters; the store stays within
//                 learnings.maxEntries; governing in neither tree; the path did not exist before
//   learning-retire  exactly one change: the declared file deleted, directly inside the learnings
//                 directory as it resolves in both trees, an ordinary file that was exactly the
//                 pinned blob in the comparison tree; never edited, in the candidate or in any own
//                 commit; governing in neither tree
export function candidateViolations({ objects, task, config, owned, head, comparison }) {
  const violations = [], add = (code, detail, extra = {}) => violations.push({ code, detail, ...extra });
  const kind = task?.upkeep?.kind, problems = CHECKED_KINDS.includes(kind) ? markerProblems(task) : [`the marker is not of kind ${CHECKED_KINDS.join(', ')}`];
  if (problems.length) { add('marker', problems.join('; ')); return { violations, changed: [] }; }
  try { return kindViolations({ kind, objects, reader: strictTreeReader(objects), task, config, owned, head, comparison, violations, add }); }
  catch (error) {
    if (!(error instanceof InvalidTreeName)) throw error;
    add('tree-name', `${error.message}; two different Git paths could read as one, so the candidate cannot be checked`);
    return { violations, changed: [] };
  }
}
// The name slice 5 part A gave it; the docs tests call it.
export const docsCandidateViolations = candidateViolations;
function kindViolations({ kind, objects, reader, task, config, owned, head, comparison, violations, add }) {
  const marker = task.upkeep, adding = kind === 'learning-add', retiring = kind === 'learning-retire', learningKind = adding || retiring, noun = `a ${kind} task`;
  // The declared files: path -> the blob pinned for it, or null for the one file a learning-add adds.
  const declared = adding ? new Map([[marker.learning.path, null]]) : retiring ? new Map([[marker.learning.path, marker.learning.blob]]) : new Map(marker.files.map(file => [file.path, file.blob]));
  const settings = upkeepSettings(config ?? {}).docs, pinnedMode = path => learningKind ? REGULAR : marker.files.find(file => file.path === path)?.mode ?? REGULAR;
  const limits = kind === 'docs' ? { maxFiles: Math.min(marker.limits.maxFiles, settings.maxFiles), maxChangedLines: Math.min(marker.limits.maxChangedLines, settings.maxChangedLines) }
    : kind === 'context' ? { maxFiles: Math.min(marker.limits.maxFiles, marker.files.length), maxChangedLines: Math.min(marker.limits.maxChangedLines, CONTEXT_LINES_PER_PROPOSAL * marker.candidates.length) }
    : kind === 'check' ? { maxFiles: Math.min(marker.limits.maxFiles, marker.files.length, CHECK_MARKER_MAX_FILES), maxChangedLines: Math.min(marker.limits.maxChangedLines, CHECK_MAX_CHANGED_LINES) }
    : retiring ? { maxFiles: 1, maxChangedLines: Infinity }
    : { maxFiles: 1, maxChangedLines: Infinity, maxChars: Math.min(marker.limits.maxChars, LEARNING_MAX_CHARS) };
  // The modes a changed file may have on every side: ordinary, or for a check script also executable.
  const allowedModes = kind === 'check' ? CHECK_SCRIPT_MODES : [REGULAR];
  // A check task: the scripts of the fast checks configured at this operation (operations/upkeep-capture.mjs).
  const scripts = kind === 'check' ? scriptsByPath(config ?? {}) : null;
  const trees = { comparison: objects.commit(comparison).tree, candidate: objects.commit(head).tree };
  const lookups = { comparison: gitTreeLookup(reader, trees.comparison), candidate: gitTreeLookup(reader, trees.candidate) };
  // The governing set of 7.1 in both trees, with the configuration current at this point.
  const views = [treeView(lookups.comparison, config?.context), treeView(lookups.candidate, config?.context)];
  // A check task: the files any other word of that configuration reaches, in each tree, through
  // normalization and links (review of 6f83d54, P2).
  const namedIn = kind === 'check' ? Object.entries(lookups).map(([name, lookup]) => ({ name, ...scriptsNamedElsewhere(config ?? {}, lookup) })) : [];
  // The learnings directory, resolved in each tree as a governing path is: a directory reached
  // through a link is where it really is. One that a tree cannot place leaves nothing provably
  // outside it, so every change is refused (fail closed).
  const learningsDir = learningsSettings(config ?? {}).dir, learnings = [];
  const learningsIn = {};
  if (learningsDir) for (const [name, lookup] of Object.entries(lookups)) {
    const found = resolveTreePath(lookup, learningsDir);
    if (found.unresolvable) add('learnings-unresolvable', `the learnings directory ${JSON.stringify(learningsDir)} cannot be resolved in the ${name} tree (${found.unresolvable}); nothing can be shown to be outside it`);
    else { learnings.push(found.path); learningsIn[name] = found; }
  }
  if (learningsDir) learnings.push(learningsDir);
  // A learning-add task adds its file to (a learning-retire task deletes it from) the learnings
  // directory as configured now, which must be the directory it was accepted for, and where it
  // really is: named exactly, reached through no link.
  if (learningKind) {
    if (!learningsDir) add('learnings', `no learnings directory is configured (learnings.dir); ${noun} changes its file only there`);
    else if (learningsDir !== marker.learning.dir) add('learnings', `the learnings directory is now ${learningsDir}, not ${marker.learning.dir}, which the task was accepted for`);
    for (const [name, found] of Object.entries(learningsIn)) if (found.path !== learningsDir || found.hops || found.exists && found.type !== 'directory') add('learnings', `the learnings directory ${learningsDir} is not a plain directory named exactly in the ${name} tree (it resolves to ${found.path}${found.hops ? ' through a symbolic link' : ''})`);
  }

  // Pinned blobs: each declared file, in the comparison tree, is exactly the ordinary file it was
  // validated at. A file changed under the task (by the target, or before the workspace was
  // prepared) means the task is stale.
  for (const [path, blob] of declared) {
    const { entry } = entryAt(reader, trees.comparison, path);
    // The one file a learning-add task adds does not exist before it, in any letter case.
    if (blob === null) {
      const parent = path.split('/').slice(0, -1), name = path.split('/').at(-1).toLowerCase(), folder = entryAt(reader, trees.comparison, parent.join('/')).entry;
      const clash = entry ? path.split('/').at(-1) : folder?.mode === DIRECTORY ? reader.tree(folder.id).find(row => row.name.toLowerCase() === name)?.name : null;
      if (clash) add('pinned', `the file a learning-add task adds, ${path}, already exists in the comparison commit ${comparison.slice(0, 12)}${clash !== path.split('/').at(-1) ? ` as ${[...parent, clash].join('/')}` : ''}`, { path });
      continue;
    }
    if (!entry || entry.mode !== pinnedMode(path) || entry.id !== blob) add('pinned', `the declared file ${path} is not the file the task was validated against (expected ${pinnedMode(path)} blob ${blob.slice(0, 12)}, found ${entry ? `${entry.mode} ${entry.id.slice(0, 12)}` : 'nothing'}) in the comparison commit ${comparison.slice(0, 12)}`, { path });
  }

  // The path rules, for a path the candidate, or one of its own commits, changes.
  const judgedPaths = new Map();
  const judgePath = (path, where, extra = {}) => {
    if (judgedPaths.has(path)) return judgedPaths.get(path).forEach(row => add(row.code, `${row.detail}${where}`, { path, ...extra }));
    const found = [], note = (code, detail) => found.push({ code, detail });
    if (!declared.has(path)) note('undeclared', `${path} is not one of the task's declared files (${[...declared.keys()].join(', ')})`);
    const governing = governingAcross(views, path);
    const governingNever = what => { if (governing.either) note('governing', `${path} is governing context in the ${governing.results.map((row, index) => row.governing ? ['comparison', 'candidate'][index] : null).filter(Boolean).join(' and ')} tree (${[...new Set(governing.results.filter(row => row.governing).map(row => row.reason))].join(', ')}); ${what} never changes a governing file`); };
    if (kind === 'check') {
      governingNever('a check task');
      // Still, under the configuration at this operation, the script of a configured fast check that
      // no other configured word names: a change to the configuration since acceptance is judged.
      const checks = scripts.get(path), file = marker.files.find(row => row.path === path);
      if (!checks) note('not-check-script', `${path} is not, under the configuration now, the script of a configured fast check that no other configured word names; a check task changes only those`);
      for (const tree of namedIn) {
        if (!tree.complete) note('not-check-script', `the configuration holds more than ${MAX_RESOLVED_WORDS} words, so it cannot be shown in the ${tree.name} tree that nothing else names ${path}`);
        else if (tree.files.has(path.toLowerCase())) note('not-check-script', `${path}: ${NAMED_ELSEWHERE} (in the ${tree.name} tree)`);
      }
      if (checks && file && !file.checks.every(id => checks.includes(id))) note('not-check-script', `${path} is no longer the script of fast check ${file.checks.filter(id => !checks.includes(id)).join(', ')}, which the task was accepted for`);
    } else if (learningKind) {
      governingNever(noun);
      // Required: directly inside the learnings directory, in both trees, named exactly.
      const parent = path.split('/').slice(0, -1).join('/');
      if (!learningsDir || parent !== learningsDir || Object.values(learningsIn).some(found => found.path !== parent)) note('outside-learnings', `${path} is not directly inside the learnings directory${learningsDir ? ` ${learningsDir}` : ''}; ${noun} ${adding ? 'adds' : 'deletes'} its one file there`);
    } else if (kind === 'docs') {
      if (!settings.include.some(glob => matchesGlob(glob, path)) || settings.exclude.some(glob => matchesGlob(glob, path))) note('not-docs', `${path} is not in the project's declared docs (upkeep.docs.include less exclude)`);
      if (governing.either) note('governing', `${path} is governing context in the ${governing.results.map((row, index) => row.governing ? ['comparison', 'candidate'][index] : null).filter(Boolean).join(' and ')} tree (${[...new Set(governing.results.filter(row => row.governing).map(row => row.reason))].join(', ')}); a docs task never changes a governing file`);
    } else {
      // Required: a governing file, one the context loader would deliver, in both trees.
      if (!governing.both) note('not-governing', `${path} is not a governing file in the ${governing.results.map((row, index) => row.protectedFile ? null : ['comparison', 'candidate'][index]).filter(Boolean).join(' and ')} tree; a context task changes governing files only`);
      // ... reached by exactly the entries the marker names for it, each always delivered.
      const file = marker.files.find(row => row.path === path);
      if (file) for (const id of file.entries) {
        const entry = (config?.context?.files ?? []).find(row => row?.id === id);
        if (!entry) { note('entry', `context entry ${id}, which the task names for ${path}, is not configured`); continue; }
        if (entry.required !== true || entry.paths !== undefined) note('entry', `context entry ${id} is ${entry.required !== true ? 'not required' : 'path-mapped'}; a context task changes only entries that are always delivered`);
        for (const [index, view] of views.entries()) { const found = resolveTreePath(view.lookup, entry.path); if (found.unresolvable || found.path !== path) note('entry', `context entry ${id} (${entry.path}) does not reach ${path} in the ${['comparison', 'candidate'][index]} tree`); }
      }
    }
    const resolved = views.map(view => resolveTreePath(view.lookup, path)).filter(row => !row.unresolvable).map(row => row.path);
    if ([path, ...resolved].some(at => upgradeOwnedPath(owned, at))) note('upgrade-owned', `${path} is upgrade-owned`);
    if (!learningKind && learnings.some(directory => [path, ...resolved].some(at => lowerInside(directory, at)))) note('learnings', `${path} is in the learnings directory`);
    // No link or submodule, and nothing that is not a folder, in any directory above the path, in either tree.
    for (const [name, tree] of Object.entries(trees)) for (const row of entryAt(reader, tree, path).above) if (row.mode !== DIRECTORY) note('link-above', `${row.path}, above ${path}, is ${row.mode === LINK ? 'a symbolic link' : row.mode === SUBMODULE ? 'a submodule' : 'not a folder'} in the ${name} tree`);
    judgedPaths.set(path, found);
    found.forEach(row => add(row.code, `${row.detail}${where}`, { path, ...extra }));
  };
  // The entry rules: no addition, no deletion, no link or submodule, an ordinary file whose mode is unchanged.
  const judgeEntry = (path, befores, after, where, extra = {}) => {
    const what = adding ? 'adds exactly its one declared file, and changes, renames and deletes nothing' : retiring ? 'deletes exactly its one declared file, and adds, changes and renames nothing' : 'adds, renames and deletes nothing';
    // A learning-retire task's one deletion is its declared file; nothing is deleted otherwise.
    if (!after && !(retiring && declared.has(path))) add('deletion', `${path} is deleted${where}; ${noun} ${what}`, { path, ...extra });
    // ... and it never edits that file, not even in an own commit that a later one deletes (P1).
    if (retiring && declared.has(path) && after && befores.some(Boolean)) add('learning-edit', `${path} is changed${where}; ${noun} only deletes it, with exactly the content it was accepted with, and never edits it`, { path, ...extra });
    // A learning-add task's one addition is its declared file; in its own commits that file may also
    // be written again before the end.
    if (befores.every(before => !before) && !(adding && declared.has(path))) add('addition', `${path} is added${where}; ${noun} ${what}`, { path, ...extra });
    for (const side of [...befores, after].filter(Boolean)) {
      if (side.mode === LINK) add('link', `${path} is a symbolic link${where}; no link may be added, changed or removed`, { path, ...extra });
      else if (side.mode === SUBMODULE) add('submodule', `${path} is a submodule${where}; no submodule may be added, changed or removed`, { path, ...extra });
      else if (!allowedModes.includes(side.mode)) add('mode', `${path} has mode ${side.mode}${where}; ${noun} changes only ${kind === 'check' ? 'ordinary or executable regular files' : 'ordinary, non-executable files'} and never a mode`, { path, ...extra });
    }
    const modes = [...befores, after].filter(Boolean).map(side => side.mode);
    if (new Set(modes).size > 1 && modes.every(mode => mode !== LINK && mode !== SUBMODULE)) add('mode', `${path} changes mode (${[...new Set(modes)].join(' to ')})${where}`, { path, ...extra });
  };

  // The candidate against the comparison commit: exactly what the merge would change.
  const final = treeChanges(reader, trees.comparison, trees.candidate), content = contentReader(objects);
  const judgeContent = (path, ids, where, extra = {}) => {
    const found = content(ids);
    for (const verdict of new Set(found.values())) {
      if (verdict?.binary) add('binary', `${path} is binary${where}: ${verdict.binary}`, { path, ...extra });
      if (verdict?.exhausted) add('too-many-changes', `${path}${where} was not read: the check reads at most ${MAX_CONTENT_BLOBS} blobs and ${MAX_CONTENT_BYTES} bytes`, { path, ...extra });
    }
    return found;
  };
  if (!final.complete) add('too-many-changes', `the candidate changes more than ${MAX_COMPARED_CHANGES} entries; ${noun} changes at most ${limits.maxFiles} files`);
  let lines = 0;
  for (const row of final.changes) {
    judgePath(row.path, ''); judgeEntry(row.path, [row.before], row.after, '');
    // Content: both sides of a changed file must be text, and every changed line counts, with its
    // terminator and any byte order mark (an added or deleted file counts all its lines).
    const sides = [row.before, row.after].map(side => isBlob(side) ? side.id : null), found = judgeContent(row.path, sides.filter(Boolean), '');
    const text = id => id ? found.get(id)?.text : '';
    if (sides.every(id => text(id) !== undefined)) lines += changedLinesExact(text(sides[0]), text(sides[1]));
  }
  if (final.changes.length > limits.maxFiles) add('budget-files', `the candidate changes ${final.changes.length} files; at most ${limits.maxFiles} are allowed`);
  if (lines > limits.maxChangedLines) add('budget-lines', `the candidate changes ${lines} lines; at most ${limits.maxChangedLines} are allowed`);
  // A check script keeps the mode it was offered at, on the candidate as a whole (an own commit that
  // changes it and changes it back is judged below).
  if (kind === 'check') for (const row of final.changes) { const want = pinnedMode(row.path); if (declared.has(row.path) && row.after && CHECK_SCRIPT_MODES.includes(row.after.mode) && row.after.mode !== want) add('mode', `${row.path} would have mode ${row.after.mode}; it was offered as ${want}, and a check task never changes a mode`, { path: row.path }); }
  if (adding) learningViolations({ reader, marker, limits, trees, final, content, add, config, learningsDir });
  // The learning-retire column: the declared file, as pinned, is deleted.
  if (retiring) { const row = final.changes.find(change => change.path === marker.learning.path); if (!row || !row.before || row.after) add('learning-not-deleted', `the candidate does not delete ${marker.learning.path}; a learning-retire task deletes exactly that one file`, { path: marker.learning.path }); }
  // An accepted rule (a capture candidate in governing-rule form) is in its file afterwards, as
  // written: the builder applies exactly the accepted text (6.5), wherever in the file it belongs.
  if (kind === 'context') for (const item of (Array.isArray(marker.evidence) ? marker.evidence : []).filter(row => row?.kind === 'rule')) {
    const row = final.changes.find(change => change.path === item.file), text = row?.after && isBlob(row.after) ? content([row.after.id]).get(row.after.id)?.text : undefined;
    if (typeof text !== 'string' || !collapseWhitespace(text).includes(collapseWhitespace(String(item.text ?? '')))) add('rule-text', `the accepted rule ${item.id} is not in ${item.file} as written`, { path: item.file });
  }

  // The candidate's own commits: a path the kind does not permit may not be touched even when a
  // later commit undoes it. Content and size are judged on the candidate as a whole, above.
  const own = ownCommitChanges(objects, reader, head, comparison, MAX_COMPARED_CHANGES);
  if (!own.complete) add('too-many-changes', `a commit of the candidate's own changes more than ${MAX_COMPARED_CHANGES} entries`);
  for (const row of own.rows) {
    const where = ` (commit ${row.commit.slice(0, 12)}, which is not in the comparison commit ${comparison.slice(0, 12)})`;
    judgePath(row.path, where, { commit: row.commit }); judgeEntry(row.path, row.befores, row.after, where, { commit: row.commit });
    // Every blob an own commit wrote must be text within the limit, even when a later commit
    // replaced it. The line budget is judged on the candidate as a whole, above.
    if (isBlob(row.after)) judgeContent(row.path, [row.after.id], where, { commit: row.commit });
  }
  return { violations, changed: final.changes.map(row => row.path), lines, limits };
}
// The learning-add column's content rules: exactly the declared file added, written exactly as
// accepted, within 1,500 characters, and the store within its cap.
function learningViolations({ reader, marker, limits, trees, final, content, add, config, learningsDir }) {
  const learning = marker.learning, row = final.changes.find(change => change.path === learning.path);
  if (!row || row.before || !row.after) { add('learning-missing', `the candidate does not add ${learning.path}; a learning-add task adds exactly that one file`, { path: learning.path }); return; }
  if (!isBlob(row.after)) return;
  const text = content([row.after.id]).get(row.after.id)?.text; if (typeof text !== 'string') return;
  const size = learningChars(text);
  if (size > limits.maxChars) add('too-long', `${learning.path} is ${size} characters; a learning, frontmatter and title included, is at most ${limits.maxChars}`, { path: learning.path });
  const parsed = parseLearning(text);
  if (parsed.problems) { add('frontmatter', `${learning.path} is not a learning file: ${parsed.problems.join('; ')}`, { path: learning.path }); return; }
  const differ = ['id', 'title', 'paths', 'kind', 'enforced_by', 'last_verified', 'retire_when'].filter(name => JSON.stringify(parsed.fields[name]) !== JSON.stringify(learning[name]));
  if (differ.length) add('frontmatter', `the frontmatter of ${learning.path} does not match the accepted learning (${differ.join(', ')} differ${differ.length === 1 ? 's' : ''})`, { path: learning.path });
  if (parsed.fields.body !== learning.body.replace(/\n+$/u, '')) add('learning-text', `the body of ${learning.path} is not exactly the accepted learning text`, { path: learning.path });
  // A hand-written learning may space its paths list (dev.92, P3); one the factory adds is the
  // accepted text byte for byte.
  else if (!differ.length && text !== renderLearning(learning)) add('frontmatter', `${learning.path} is not written exactly as the accepted learning: write its paths line as ${JSON.stringify(`paths: ${JSON.stringify(learning.paths)}`)}`, { path: learning.path });
  // 11.1: at most learnings.maxEntries files in the store once it is added.
  const most = learningsSettings(config ?? {}).maxEntries, folder = learningsDir ? entryAt(reader, trees.candidate, learningsDir).entry : null;
  const count = folder?.mode === DIRECTORY ? reader.tree(folder.id).filter(entry => entry.mode !== DIRECTORY).length : 0;
  if (count > most) add('learnings-full', `the learnings directory would hold ${count} entries; it holds at most ${most} (learnings.maxEntries): a retirement must merge first`, { path: learning.path });
}

// The check for one operation. `head` is the candidate the operation acts on and `comparison` the
// commit it is compared with; both come from factory state. A task without a marker is not
// checked here (its kind is checked before: core/upkeep-namespace.mjs assertUpkeepEnforced).
// A refusal for nothing but pinned files carries `upkeepEnding`: the declared file changed under the
// follow-up. `stale` before any integration (`pinnedEnding` says which, from the caller), and
// `base-moved` once the comparison is the integrated target. The lifecycle returns its candidates
// with that reason (operations/upkeep-tasks.mjs); any other refusal fails them.
export function assertUpkeepCandidate({ repository, task, config, head, comparison, operation, objects = new VerifiedObjects(repository), owned = upgradeOwned(repository), pinnedEnding = operation === 'workspace.commit' ? 'stale' : 'base-moved' }) {
  if (!hasUpkeepMarker(task)) return null;
  const refuse = (detail, violations = []) => { const error = new UpkeepCandidateRefusal(`${operation}: the candidate of upkeep task ${task.id} (kind ${task.upkeep?.kind ?? 'unknown'}) is outside what its kind permits: ${detail}`, violations); if (violations.length && violations.every(row => row.code === 'pinned')) error.upkeepEnding = pinnedEnding; error.refusal = { kind: 'upkeep-limits', upkeepKind: typeof task.upkeep?.kind === 'string' ? task.upkeep.kind : null, files: [...new Set(violations.map(row => row.path).filter(path => typeof path === 'string'))].slice(0, 20), ending: error.upkeepEnding ?? null }; throw error; };
  if (!CHECKED_KINDS.includes(task.upkeep?.kind)) refuse(`this release checks only the ${CHECKED_KINDS.join(', ')} kinds`);
  // A check task: the operator's own approval of this revision and these scripts, at every operation.
  if (task.upkeep?.kind === 'check' && !checkScriptsApproved(task)) refuse(checkApprovalRefusal(task, 'its approval'), [{ code: 'approval', detail: checkApprovalRefusal(task, 'its approval') }]);
  if (!OBJECT_ID.test(head ?? '')) refuse('the candidate head is not known');
  if (!OBJECT_ID.test(comparison ?? '')) refuse('there is no comparison commit (the workspace base or the integrated target) to compare it with');
  assertNoHistoryRewrites(repository, { shallow: false });
  // The candidate must contain the comparison commit through verified parents, or nothing it is
  // compared with says what the merge would change.
  if (!objects.reaches(head, comparison)) refuse(`it does not contain the comparison commit ${comparison.slice(0, 12)} through verified parents`);
  const found = candidateViolations({ objects, task, config, owned, head, comparison });
  if (found.violations.length) refuse(found.violations.slice(0, 12).map(row => row.detail).join('; ') + (found.violations.length > 12 ? `; and ${found.violations.length - 12} more` : ''), found.violations);
  return found;
}
