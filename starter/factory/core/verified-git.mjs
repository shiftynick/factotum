// Verified reads of Git objects for checks that guard upgrade-owned files.
//
// Builder worktrees share the project's Git directory, so a builder can write its refs, config,
// info/, hooks and object files. Every decision here is therefore made from objects whose bytes
// are hashed and compared with the object ID that was asked for: commit parents and trees are
// parsed from verified content, never from Git's views of them (replace refs, grafts, shallow
// boundaries, the commit-graph cache, a rewritten loose object or pack, alternates). Only a hash
// collision could change what these checks see. In addition, Git runs with replacement objects
// and grafts switched off, and a repository with replace refs, a grafts file or a shallow history
// is refused outright, as an explicit sign of tampering or of history the checks cannot see.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS } from './git-options.mjs';

const fail = message => { throw new Error(message); };
// Added to every Git command the protection, continuity, adoption and upgrade paths rely on.
// The graft file points at a path that can never exist (a name under a device file): Git then has no
// grafts and, unlike with /dev/null itself, prints no deprecation hint.
export const NO_HISTORY_REWRITES_ENV = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/factotum-no-grafts' });
export const NO_HISTORY_REWRITES_ARGS = Object.freeze(['-c', 'core.commitGraph=false']);
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), ...NO_HISTORY_REWRITES_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
const run = (cwd, args, input, extraEnv = {}, { partial = false } = {}) => {
  const result = spawnSync('git', [...NO_AUTO_MAINTENANCE, ...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...NO_HISTORY_REWRITES_ARGS, ...args], { cwd, env: { ...env(), ...extraEnv }, input, maxBuffer: 1 << 30, timeout: 300000 });
  if (result.status !== 0 && !(partial && result.stdout)) fail(`git ${args[0]} failed while verifying history: ${String(result.stderr ?? result.error?.message ?? '').trim().slice(0, 300)}`);
  return result.stdout;
};
const text = (cwd, args) => run(cwd, args).toString('utf8').trim();
// A proposal-only Git call whose exit status the caller reads.
const spawnGit = (cwd, args, input, extraEnv) => spawnSync('git', [...NO_AUTO_MAINTENANCE, ...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...NO_HISTORY_REWRITES_ARGS, ...args], { cwd, env: { ...env(), ...extraEnv }, input, maxBuffer: 1 << 30, timeout: 300000 });
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Limits for reading the repository's shallow file as a proposal hint.
export const SHALLOW_HINT_LIMIT = 10000, SHALLOW_HINT_BYTES = SHALLOW_HINT_LIMIT * 66;

// Refuse a repository whose history Git could be told to show differently.
// shallow: also refuse a shallow history (the history walk needs all of it; tree comparisons do not).
export function assertNoHistoryRewrites(cwd, { shallow = true } = {}) {
  const common = resolve(cwd, text(cwd, ['rev-parse', '--git-common-dir']));
  if (existsSync(join(common, 'info', 'grafts'))) fail(`this repository has a grafts file (${join(common, 'info', 'grafts')}); grafts rewrite history, so the adoption checks refuse to run. Remove it`);
  const replaced = text(cwd, ['for-each-ref', '--format=%(refname)', 'refs/replace/']);
  if (replaced) fail(`this repository has replacement refs (${replaced.split('\n').slice(0, 3).join(', ')}); they substitute objects, so the adoption checks refuse to run. Remove them (git replace -d)`);
  if (shallow && (existsSync(join(common, 'shallow')) || text(cwd, ['rev-parse', '--is-shallow-repository']) === 'true')) fail('this repository is a shallow clone; the adoption checks need its complete history (git fetch --unshallow)');
}

// Old trees can store a folder's mode zero-padded (040000); compare modes in Git's canonical form.
const normalMode = mode => /^[0-7]+$/.test(mode) ? Number.parseInt(mode, 8).toString(8) : mode;

// Object reader: every object is hashed and compared with its ID.
export class VerifiedObjects {
  constructor(cwd) { this.cwd = cwd; this.cache = new Map(); }
  read(ids) {
    const wanted = [...new Set(ids)].filter(id => !this.cache.has(id));
    this.each(wanted, (id, object) => this.cache.set(id, object));
    return ids.map(id => this.cache.get(id));
  }
  // Verify and hand each object to fn without keeping it (missing objects come as null), batch by
  // batch, so a long history is read with bounded memory.
  each(wanted, fn) {
    for (const id of wanted) if (!OBJECT_ID.test(id)) fail(`invalid object id ${JSON.stringify(id)}`);
    for (let at = 0; at < wanted.length; at += 4000) {
      const batch = wanted.slice(at, at + 4000), out = run(this.cwd, ['cat-file', '--batch'], batch.join('\n') + '\n');
      let offset = 0;
      for (const id of batch) {
        const end = out.indexOf(10, offset); if (end < 0) fail('truncated object stream');
        const header = out.subarray(offset, end).toString('utf8'), [got, type, size] = header.split(' ');
        offset = end + 1;
        if (type === 'missing' || size === undefined) { fn(id, null); continue; }
        if (got !== id) fail(`object stream out of order at ${id}`);
        const length = Number(size), body = out.subarray(offset, offset + length); offset += length + 1;
        const digest = createHash(id.length === 64 ? 'sha256' : 'sha1').update(`${type} ${length}\0`).update(body).digest('hex');
        if (digest !== id) fail(`Git object ${id} does not match its id (it has been rewritten in the object store); the adoption checks refuse to continue`);
        fn(id, { type, body });
      }
    }
  }
  need(id, type) { const [object] = this.read([id]); if (!object) fail(`Git object ${id} is missing`); if (object.type !== type) fail(`Git object ${id} is a ${object.type}, not a ${type}`); return object.body; }
  static commit(body) {
    const head = body.toString('utf8').split('\n\n', 1)[0].split('\n');
    const tree = head.find(line => line.startsWith('tree '))?.slice(5);
    if (!tree || !OBJECT_ID.test(tree)) fail('commit without a tree');
    return { tree, parents: head.filter(line => line.startsWith('parent ')).map(line => line.slice(7)) };
  }
  static tree(body, idLength) {
    const entries = [], raw = idLength / 2; let at = 0;
    while (at < body.length) {
      const space = body.indexOf(32, at), nul = body.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 1 + raw > body.length) fail('malformed tree object');
      entries.push({ mode: normalMode(body.subarray(at, space).toString('utf8')), name: body.subarray(space + 1, nul).toString('utf8'), id: body.subarray(nul + 1, nul + 1 + raw).toString('hex') });
      at = nul + 1 + raw;
    }
    return entries;
  }
  // The sizes the object store reports, by id (a missing object, or one of another type, is left out).
  // A bound only: a blob reported smaller than its content is caught when it is read and hashed.
  blobSizes(ids) {
    const wanted = [...new Set(ids)]; for (const id of wanted) if (!OBJECT_ID.test(id)) fail(`invalid object id ${JSON.stringify(id)}`);
    const sizes = new Map(); if (!wanted.length) return sizes;
    for (const line of run(this.cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], wanted.join('\n') + '\n').toString('utf8').split('\n').filter(Boolean)) { const [id, type, size] = line.split(' '); if (type === 'blob' && /^\d+$/.test(size ?? '')) sizes.set(id, Number(size)); }
    return sizes;
  }
  commit(id) { return VerifiedObjects.commit(this.need(id, 'commit')); }
  tree(id) { return VerifiedObjects.tree(this.need(id, 'tree'), id.length); }
  blob(id) { return this.need(id, 'blob'); }
  // Everything at a path in a commit, matching each segment without regard to case, so a case
  // variant (FACTORY/, Factotum.Lock.Json) or an entry that is not a folder where a folder is
  // expected (a symlink, a submodule) changes the result. Returns a stable identity string.
  identity(commitId, path) {
    let frontier = [{ id: this.commit(commitId).tree, path: '' }]; const found = [];
    const segments = path.split('/');
    segments.forEach((segment, index) => {
      const next = [];
      for (const node of frontier) for (const entry of this.tree(node.id)) {
        if (entry.name.toLowerCase() !== segment.toLowerCase()) continue;
        const at = node.path ? `${node.path}/${entry.name}` : entry.name;
        if (index === segments.length - 1 || entry.mode !== '40000') found.push(`${entry.mode} ${entry.id} ${at}`);
        else next.push({ id: entry.id, path: at });
      }
      frontier = next;
    });
    return found.sort().join('\n');
  }
  // ---- The verified commit graph ----
  // Every walk below follows parents parsed from hash-verified commits. `git rev-list` is used only
  // to propose which commits to read in large batches; what it lists, omits or orders never changes
  // an answer, only how many Git processes the walk needs.
  //
  // commits: id -> { tree, parents } for a commit read and verified, or null for an ID that is absent
  // from the object store (a real shallow clone's boundary, a fabricated parent) or not a commit.
  loadCommits(ids) {
    if (!this.commits) this.commits = new Map();
    const wanted = [...new Set(ids)].filter(id => !this.commits.has(id));
    this.each(wanted, (id, object) => { const commit = object?.type === 'commit' ? VerifiedObjects.commit(object.body) : null; this.commits.set(id, commit); if (!commit) this.gaps = (this.gaps ?? 0) + 1; });
  }
  // Propose the commits reachable from starts and not from exclude, and load (verify) them in batches.
  // rev-list runs with replace refs, grafts and the commit-graph off and with the repository's
  // shallow file replaced by our own list of commits verified to have an absent parent, so a planted
  // shallow file cannot cut it short and a known gap cannot stop it. Missing commits are listed
  // (`--missing=print`, Git 2.44 or later) rather than ending the listing; an older Git stops at the
  // first unknown gap, and its error names the commit, which is then verified and added to the list
  // for the next proposal. The repository's own shallow file (a real clone's boundary, or one a
  // builder wrote) is read once as a hint and verified: its commits and their parents are read in two
  // batches, and only commits with a parent that is really absent become known gaps, so a planted
  // file naming every commit cannot make each listing stop at the next one. Returns the IDs listed.
  propose(starts, exclude = []) {
    if (!this.commits) this.commits = new Map();
    this.proposals = (this.proposals ?? 0) + 1;
    if (!this.shallowHintRead) { this.shallowHintRead = true; const hinted = this.shallowHint(); this.loadCommits(hinted); this.loadCommits(hinted.flatMap(id => this.commits.get(id)?.parents ?? [])); }
    const cuts = new Set();
    for (const [id, commit] of this.commits) if (commit?.parents.some(parent => this.commits.get(parent) === null)) cuts.add(id);
    let dir = null, shallowFile = '/dev/null/factotum-no-shallow';
    if (cuts.size) { dir = mkdtempSync(join(tmpdir(), 'factotum-walk-')); shallowFile = join(dir, 'shallow'); writeFileSync(shallowFile, [...cuts].join('\n') + '\n'); }
    try {
      const extraEnv = { GIT_SHALLOW_FILE: shallowFile };
      const list = excluded => {
        const input = [...starts, ...excluded.map(id => `^${id}`)].join('\n') + '\n';
        let result = this.missingPrint === false ? null : spawnGit(this.cwd, ['rev-list', '--missing=print', '--stdin'], input, extraEnv);
        if (result && result.status === 129) { this.missingPrint = false; result = null; }
        return result ?? spawnGit(this.cwd, ['rev-list', '--stdin'], input, extraEnv);
      };
      let result = list(exclude);
      // An older Git that meets a gap while marking the exclusions fails before listing anything and
      // names no commit; listing without exclusions names it (and lists what comes before it).
      if (result.status !== 0 && exclude.length && !String(result.stdout ?? '').trim() && !/parents of commit [0-9a-f]{40,64}/.test(String(result.stderr ?? ''))) result = list([]);
      const lines = String(result.stdout ?? '').split('\n'), listed = lines.filter(line => OBJECT_ID.test(line)), missing = lines.filter(line => line[0] === '?' && OBJECT_ID.test(line.slice(1))).map(line => line.slice(1));
      const stopped = result.status === 0 ? [] : [...String(result.stderr ?? '').matchAll(/parents of commit ([0-9a-f]{40,64})/g)].map(match => match[1]);
      this.loadCommits([...listed, ...missing, ...stopped]);
      // Where an older Git stopped: verify the commit's parents, so a missing one becomes a known gap.
      this.loadCommits(stopped.flatMap(id => this.commits.get(id)?.parents ?? []));
      return listed;
    } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  }
  // The repository's shallow file as a hint: at most SHALLOW_HINT_LIMIT entries in a file of at most
  // SHALLOW_HINT_BYTES (past either limit it is ignored, as it is only a hint), and of those only
  // the IDs `cat-file --batch-check` reports as commits (type and size only, so a hint naming large
  // blobs reads none of them).
  shallowHint() {
    let path;
    try { path = resolve(this.cwd, text(this.cwd, ['rev-parse', '--git-path', 'shallow'])); } catch { return []; }
    let body; try { body = readShallowFile(path); } catch { return []; }
    if (body === null) return [];
    const ids = [...new Set(body.split('\n').filter(line => OBJECT_ID.test(line)))];
    if (!ids.length || ids.length > SHALLOW_HINT_LIMIT) return [];
    const checked = run(this.cwd, ['cat-file', '--batch-check'], ids.join('\n') + '\n', {}, { partial: true }).toString('utf8').split('\n');
    return checked.map(line => line.split(' ')).filter(([id, type]) => OBJECT_ID.test(id) && type === 'commit').map(([id]) => id);
  }
  // Commits whose whole ancestry is already verified (absent IDs count as ends), and of those the
  // ones no other such commit has as a parent. Passing them as ^exclusions keeps a later proposal
  // from listing verified history again; it hides nothing still to be read, by construction.
  closedTips() {
    const closed = new Map(), commits = this.commits ?? new Map();
    const isClosed = start => {
      const stack = [start];
      while (stack.length) {
        const id = stack.at(-1);
        if (closed.has(id)) { stack.pop(); continue; }
        if (!commits.has(id)) { closed.set(id, false); stack.pop(); continue; }
        const commit = commits.get(id);
        if (commit === null) { closed.set(id, true); stack.pop(); continue; }
        const pending = commit.parents.filter(parent => !closed.has(parent));
        if (pending.length) { stack.push(...pending); continue; }
        closed.set(id, commit.parents.every(parent => closed.get(parent))); stack.pop();
      }
      return closed.get(start);
    };
    const tips = new Set();
    for (const [id, commit] of commits) if (commit && isClosed(id)) tips.add(id);
    for (const id of [...tips]) for (const parent of commits.get(id).parents) tips.delete(parent);
    return [...tips];
  }
  // Breadth-first walk over verified parents from starts. enter(id) decides whether a reached commit
  // is visited (read, and its parents followed); done(seen) ends the walk early. Returns every ID
  // reached, visited or not, present or absent.
  // 1. The first generations are read directly, one batch each: a legitimate target, base or
  //    boundary is usually a few parents away.
  // 2. After that, whenever the frontier holds commits not yet read, the walk proposes everything
  //    reachable from them (rev-list, see propose) excluding history already verified, and loads it in
  //    batches. A complete proposal covers the rest of the walk; one that stopped early (an older Git
  //    at a gap) or left something out makes the walk propose again from the commits it then reaches
  //    unread. Proposals start only from commits already read and verified (the frontier is read
  //    first), so an absent or unreadable ID never reaches rev-list as a start. A proposal that brings
  //    nothing new pauses proposing: the walk reads each generation directly until it verifies a new
  //    gap (an absent parent) or, failing that, for 1, 2, 4, … generations after each fruitless
  //    proposal, and then proposes again with what it has learnt. Fruitless proposals are therefore
  //    at most logarithmic in the generations read between two fruitful ones, plus one per new gap.
  // exclude(round, seen): further ^exclusions for the proposals of this walk, by proposal round, given
  // the IDs reached so far.
  walk(starts, { enter = () => true, done = () => false, exclude = () => [], directGenerations = 64 } = {}) {
    if (!this.commits) this.commits = new Map();
    const seen = new Set(); let frontier = [], generation = 0, round = 0, retryAt = directGenerations, backoff = 1, pausedAtGaps = Infinity;
    for (const id of starts) if (!seen.has(id)) { seen.add(id); if (enter(id)) frontier.push(id); }
    while (frontier.length && !done(seen)) {
      this.loadCommits(frontier);
      if (generation >= directGenerations && (generation >= retryAt || (this.gaps ?? 0) > pausedAtGaps)) {
        const pending = frontier.filter(id => this.commits.get(id)?.parents.some(parent => !this.commits.has(parent)));
        if (pending.length) {
          const known = this.commits.size;
          this.propose(pending, [...new Set([...exclude(round++, seen), ...this.closedTips()])]);
          // A fruitless proposal pauses proposing: it resumes on a newly verified gap, and in any case
          // after 1, 2, 4, … further generations (a gap can be known already yet not be a listed cut
          // until the commit naming it is read), so a pause never lasts more than the walk has read.
          if (this.commits.size === known) { pausedAtGaps = this.gaps ?? 0; retryAt = generation + backoff; backoff *= 2; }
          else { pausedAtGaps = Infinity; retryAt = generation; backoff = 1; }
        }
      }
      const next = [];
      for (const id of frontier) for (const parent of this.commits.get(id)?.parents ?? []) if (!seen.has(parent)) { seen.add(parent); if (enter(parent)) next.push(parent); }
      frontier = next; generation++;
    }
    return seen;
  }
  // Whether target is provably reachable from head: a path of parents parsed from hash-verified
  // commits. false means "not shown", never "not integrated"; callers that trust the target must
  // refuse on false. The answer never depends on rev-list or a shallow file. A commit that is
  // genuinely absent ends its branch.
  reaches(head, target, options = {}) {
    if (head === target) return true;
    let found = false;
    this.walk([head], { ...options, enter: id => { if (id === target) found = true; return !found; }, done: () => found });
    return found;
  }
  // The commits reachable from head but not from any of the trusted commits, each verified, and the
  // proof of that split: every commit treated as trusted is reached from a trusted commit through
  // verified parents. rev-list proposes the split (head --not trusted); a commit it leaves out is
  // only treated as trusted once the trusted walk reaches it, and otherwise is walked as the
  // candidate's own. Work is linear in the commits read.
  ownCommits(head, trusted) {
    if (!this.commits) this.commits = new Map();
    const tips = new Set(trusted), proposed = new Set(tips.has(head) ? [] : this.propose([head], [...tips]));
    const own = new Set(), claimed = new Set();
    // The candidate's side as proposed; anything else it reaches is claimed to be trusted history.
    this.walk([head], { enter: id => { if (tips.has(id) || !proposed.has(id)) { claimed.add(id); return false; } own.add(id); return true; } });
    // Prove each claim from the trusted side. Proposals stop at the claimed commits not reached yet for
    // the first rounds, so they list only the history between them and the trusted tips; claims nested
    // below other claims take a further round each, so after three the walk proposes without them.
    // Only commits that exist can be exclusions (an absent one would end the listing), so read them first.
    this.loadCommits([...claimed, ...tips]);
    const present = ids => ids.filter(id => this.commits.get(id));
    // Exclusions are only the claims not reached yet, never a trusted tip: excluding a tip (itself
    // usually claimed, as the parent of the factory's merge) would empty every listing.
    const reached = this.walk([...tips], { done: seen => [...claimed].every(id => seen.has(id)), exclude: (round, seen) => round < 3 ? present([...claimed].filter(id => !tips.has(id) && !seen.has(id))) : [] });
    const unproven = [...claimed].filter(id => !reached.has(id));
    // A commit not shown to be trusted is the candidate's own, and so is what it reaches outside the
    // trusted history (which the walk above has now read in full).
    if (unproven.length) this.walk(unproven, { enter: id => { if (reached.has(id)) return false; own.add(id); return true; }, exclude: () => present([...tips]) });
    return [...own];
  }
  // identity(commit, path) for many root trees and paths at once, reading trees level by level in
  // batches and keeping only the matching entries. Returns tree -> [identity per path].
  identities(trees, paths) {
    const result = new Map(trees.map(tree => [tree, paths.map(() => [])])), segments = paths.map(path => path.split('/'));
    let work = [];
    for (const root of new Set(trees)) segments.forEach((_, index) => work.push({ root, index, tree: root, path: '', depth: 0 }));
    while (work.length) {
      const byTree = new Map();
      for (const item of work) { if (!byTree.has(item.tree)) byTree.set(item.tree, []); byTree.get(item.tree).push(item); }
      const next = [];
      this.each([...byTree.keys()], (id, object) => {
        if (object?.type !== 'tree') fail(`Git object ${id} is ${object ? `a ${object.type}, not a tree` : 'missing'}`);
        const entries = VerifiedObjects.tree(object.body, id.length);
        for (const item of byTree.get(id)) {
          const parts = segments[item.index], segment = parts[item.depth].toLowerCase();
          for (const entry of entries) {
            if (entry.name.toLowerCase() !== segment) continue;
            const at = item.path ? `${item.path}/${entry.name}` : entry.name;
            if (item.depth === parts.length - 1 || entry.mode !== '40000') result.get(item.root)[item.index].push(`${entry.mode} ${entry.id} ${at}`);
            else next.push({ ...item, tree: entry.id, path: at, depth: item.depth + 1 });
          }
        }
      });
      work = next;
    }
    for (const [tree, found] of result) result.set(tree, found.map(rows => rows.sort().join('\n')));
    return result;
  }
  // Upgrade-owned paths that a commit of the candidate's own changes: each commit reachable from head
  // but not from trusted (the recorded target, or the workspace base before an integration), checked
  // against its parents. A commit changes a path when its content there differs from every parent's,
  // so a merge that takes one side unchanged (the factory's merge of the target) changes nothing,
  // while the commit that first brought new content, or a later one that undid it, does.
  // Returns [{ commit, path }]; each commit is shown, through verified parents, not to be trusted.
  ownChanges(head, trusted, paths) {
    const own = this.ownCommits(head, trusted), commits = this.commits, touched = [];
    if (!own.length) return touched;
    const trees = new Set();
    for (const id of own) {
      if (!commits.get(id)) fail(`commit ${id.slice(0, 12)} of the candidate's own history cannot be read; it cannot be checked`);
      trees.add(commits.get(id).tree);
      for (const parent of commits.get(id).parents) {
        if (!commits.has(parent)) this.loadCommits([parent]);
        if (!commits.get(parent)) fail(`commit ${id.slice(0, 12)} has a parent ${parent.slice(0, 12)} that cannot be read; the candidate's own history cannot be checked`);
        trees.add(commits.get(parent).tree);
      }
    }
    const at = this.identities([...trees], paths);
    for (const id of own) {
      const { tree, parents } = commits.get(id), mine = at.get(tree);
      paths.forEach((path, index) => { if (parents.length ? parents.every(parent => at.get(commits.get(parent).tree)[index] !== mine[index]) : mine[index] !== '') touched.push({ commit: id, path }); });
    }
    if (!touched.length) return touched;
    // Before refusing, show each such commit outside the trusted history: a proposal that listed
    // trusted commits as the candidate's own would otherwise refuse the target's own changes.
    const suspects = new Set(touched.map(row => row.commit));
    const trustedHistory = this.walk(trusted, { done: seen => [...suspects].every(id => seen.has(id)) });
    return touched.filter(row => !trustedHistory.has(row.commit));
  }
}

// The complete, verified commit graph reachable from HEAD and the adoption lock at each commit.
// rev-list only proposes the commits: each is verified, its parents come from its own content, and
// the set must be closed under parents, so nothing can hide a commit (or a deletion) from the walk.
// shallow: true for a lookup that may run in a shallow clone (the runtime's "is there a lock in
// history" when the lock is missing). The walk then stops at the clone's boundary commits, which
// it cannot see past; everywhere else a shallow clone is refused.
const histories = new Map();
export function lockHistoryGraph(root, lockName, { shallow = false } = {}) {
  assertNoHistoryRewrites(root, { shallow: !shallow });
  const head = text(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  // The shallow boundary is part of the key: the same HEAD with another boundary is another walk.
  const key = `${resolve(root)}\0${head}\0${lockName}\0${shallow}\0${readShallow(root).join(',')}`;
  if (histories.has(key)) return histories.get(key);
  const objects = new VerifiedObjects(root), listed = text(root, ['rev-list', head]).split('\n').filter(Boolean);
  const boundary = new Set(shallow ? readShallow(root) : []);
  // Commits: keep only tree and parents, never the object bodies.
  const commits = new Map();
  objects.each(listed, (id, object) => { if (object?.type !== 'commit') fail(`history is incomplete: commit ${id.slice(0, 12)} cannot be read`); commits.set(id, VerifiedObjects.commit(object.body)); });
  const reachable = new Set(), stack = [head];
  while (stack.length) {
    const id = stack.pop(); if (reachable.has(id)) continue;
    const commit = commits.get(id); if (!commit) fail(`history is incomplete: commit ${id.slice(0, 12)} is missing from the walk; the adoption checks refuse to continue`);
    reachable.add(id); if (!boundary.has(id)) stack.push(...commit.parents);
  }
  // Root trees: keep only the lock's entry.
  const trees = new Map(), lockAt = new Map();
  for (const id of reachable) { const tree = commits.get(id).tree; if (!trees.has(tree)) trees.set(tree, []); trees.get(tree).push(id); }
  objects.each([...trees.keys()], (tree, object) => {
    if (object?.type !== 'tree') fail(`history is incomplete: tree ${tree.slice(0, 12)} cannot be read`);
    const entry = VerifiedObjects.tree(object.body, tree.length).find(row => row.name === lockName) ?? null;
    for (const id of trees.get(tree)) lockAt.set(id, entry);
  });
  const graph = new Map(), blobs = new Set();
  for (const id of reachable) {
    const entry = lockAt.get(id);
    if (entry?.mode === '100644' || entry?.mode === '100755') blobs.add(entry.id);
    graph.set(id, { parents: boundary.has(id) ? [] : commits.get(id).parents, lock: entry });
  }
  objects.read([...blobs]);
  const result = { head, graph, blob: id => objects.blob(id) };
  histories.clear(); histories.set(key, result);
  return result;
}
// The commits a shallow file names (a real clone's boundary, or one a builder wrote): a hint only.
export const shallowBoundary = root => readShallow(root);
function readShallow(root) {
  const path = resolve(root, text(root, ['rev-parse', '--git-path', 'shallow']));
  const body = readShallowFile(path);
  return body === null ? [] : body.split('\n').filter(line => OBJECT_ID.test(line));
}
// A shallow file's text, or null when there is none. Only a regular file is read: it is opened
// without following a link and without blocking, so a FIFO, device or link a builder put there
// cannot hang or flood a check, and never more than SHALLOW_HINT_BYTES is read. Anything else, or
// a larger file, is refused (thrown), and callers fail closed or ignore the hint.
function readShallowFile(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`cannot read the shallow file safely: ${error.code ?? error.message}`); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('the shallow file is not a regular file');
    if (info.size > SHALLOW_HINT_BYTES) throw new Error(`the shallow file exceeds ${SHALLOW_HINT_BYTES} bytes`);
    const buffer = Buffer.alloc(info.size), read = info.size ? readSync(fd, buffer, 0, info.size, 0) : 0;
    return buffer.subarray(0, read).toString('utf8');
  } finally { closeSync(fd); }
}
// Whether any commit reachable from HEAD has the lock (git outside a repository: false). It may run
// in a shallow clone: a project without a lock, whose visible history never had one, works there.
export function lockInHistory(root, lockName) {
  try { text(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']); } catch { return null; }
  const { graph } = lockHistoryGraph(root, lockName, { shallow: true });
  for (const [id, row] of graph) if (row.lock) return id;
  return null;
}
