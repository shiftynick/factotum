// Provider configuration in a candidate (docs/changes/provider-worktree-isolation.md).
//
// Provider CLIs can load configuration, skills, hooks, commands, agents and instructions from
// folders in their working directory: Codex from .codex/ and .agents/, Claude Code from .claude/
// and .mcp.json. Every model step starts its provider with that loading turned off
// (adapters/providers/index.mjs, WORKTREE_ISOLATION). As a second line, a candidate may add, change
// or remove such paths only when its task declares them: a builder cannot leave provider
// configuration behind for a later step (or a later flow, or a person's own CLI) to load as
// instructions, unless the operator asked for exactly that.
//
// A path counts when any component is one of PROVIDER_CONFIG_FOLDERS, or its last component is one
// of PROVIDER_CONFIG_FILES, compared without regard to case (a case-insensitive file system loads
// .Claude/ as .claude/). It is declared when a path in the task's `paths` is the path itself or a
// folder above it, and that declared path is itself provider configuration: `.claude` or
// `.claude/skills/name` declares, `.` or `src` does not. A link at a provider-configuration path
// (in the comparison commit or the candidate) makes what it reaches provider configuration too,
// named through the link: changing docs/report/SKILL.md behind .agents/skills/report needs
// .agents/skills/report declared, not docs/report. A governing file in those folders still
// needs the governing-file boundary's approval too (governance-edit.mjs); this check never widens it.
//
// Trees are read through hash-verified objects (core/verified-git.mjs); only subtrees whose IDs
// differ are walked.
import { assert } from '../core/contracts.mjs';
import { VerifiedObjects } from '../core/verified-git.mjs';
import { MAX_LINK_HOPS, gitCommitLookup, resolveTreePath } from '../core/tree-paths.mjs';

export const PROVIDER_CONFIG_FOLDERS = Object.freeze(['.agents', '.claude', '.codex']);
export const PROVIDER_CONFIG_FILES = Object.freeze(['.mcp.json']);
const COMMIT = /^[a-f\d]{40,64}$/i;
const TREE = '40000', LINK = '120000';

export function isProviderConfigPath(path) {
  if (typeof path !== 'string' || !path) return false;
  const parts = path.split('/').filter(Boolean).map(part => part.toLowerCase());
  return parts.some(part => PROVIDER_CONFIG_FOLDERS.includes(part)) || PROVIDER_CONFIG_FILES.includes(parts.at(-1));
}
// The task's declared paths that name provider configuration, without a trailing slash.
export function declaredProviderConfig(task) {
  return (Array.isArray(task?.paths) ? task.paths : []).filter(path => typeof path === 'string').map(path => path.replace(/\/+$/, '')).filter(isProviderConfigPath);
}
const covered = (path, declared) => declared.some(entry => path === entry || path.startsWith(`${entry}/`));

// Every leaf path (file, link, submodule) whose entry differs between two commits: added,
// removed, or a different mode or object. A folder replaced by a file lists both sides' leaves.
// The walk goes level by level, reading each level's trees in one batch, and descends only into
// subtrees whose IDs differ.
export function changedLeaves({ objects, comparison, head }) {
  const changes = new Set();
  const entries = id => id ? new Map(objects.tree(id).map(entry => [entry.name, entry])) : new Map();
  // Pairs of trees to compare ({ before, after, path }) and whole trees whose every leaf changed ({ tree, path }).
  let pairs = [{ before: objects.commit(comparison).tree, after: objects.commit(head).tree, path: '' }], whole = [];
  while (pairs.length || whole.length) {
    objects.read([...pairs.flatMap(pair => [pair.before, pair.after]), ...whole.map(item => item.tree)].filter(Boolean));
    const nextPairs = [], nextWhole = [];
    for (const { before, after, path: prefix } of pairs) {
      const a = entries(before), b = entries(after);
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(name), y = b.get(name), path = prefix ? `${prefix}/${name}` : name;
        if (x && y && x.mode === y.mode && x.id === y.id) continue;
        if (x?.mode === TREE && y?.mode === TREE) { nextPairs.push({ before: x.id, after: y.id, path }); continue; }
        for (const side of [x, y]) if (side?.mode === TREE) nextWhole.push({ tree: side.id, path }); else if (side) changes.add(path);
      }
    }
    for (const { tree, path: prefix } of whole) for (const entry of objects.tree(tree)) {
      const path = `${prefix}/${entry.name}`;
      if (entry.mode === TREE) nextWhole.push({ tree: entry.id, path }); else changes.add(path);
    }
    pairs = nextPairs; whole = nextWhole;
  }
  return [...changes].sort();
}
// Provider-configuration paths whose entry differs between two commits, as leaf paths.
export const providerConfigChanges = input => changedLeaves(input).filter(isProviderConfigPath);

// Bounds on following links through provider configuration: links followed one after another
// from a provider-configuration path, and entries visited behind such links in one commit. Past
// either, the candidate is refused (the reach cannot be shown).
export const PROVIDER_LINK_LIMITS = Object.freeze({ hops: MAX_LINK_HOPS, entries: 50000 });

// What provider configuration reaches through symbolic links in a commit: { target, alias, link }
// rows, each saying the repository path `target` (a folder, a file, or a path that does not exist
// yet) is reached by a provider as `alias`, through the link `link`. Read through verified trees
// (core/tree-paths.mjs resolves each link as the file system would).
//
// Every link whose path is provider configuration is followed. When it reaches a folder, that
// folder is walked under the link's alias, and every link inside is followed in turn, keeping the
// alias: with .agents -> shared and shared/skills/report -> ../../docs/report, docs/report is
// reached as .agents/skills/report. A link that leaves the repository or cannot be resolved
// reaches nothing in any candidate. A link back to a folder already on the chain is a cycle: what
// it reaches has no end of names (a/loop/loop/...), and a cycle also reaches through every link
// on the way, so no set of declarations can be shown to cover it. A cycle throws
// (`providerLinkCycle`, naming the link); skill layouts never need one.
export function providerConfigLinks({ objects, commit }) {
  const lookup = gitCommitLookup(objects, commit), rows = [], budget = { entries: 0 };
  const physical = [];
  let level = [{ tree: objects.commit(commit).tree, path: '' }];
  while (level.length) {
    objects.read(level.map(item => item.tree));
    const next = [];
    for (const { tree, path: prefix } of level) for (const entry of objects.tree(tree)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === TREE) next.push({ tree: entry.id, path });
      else if (entry.mode === LINK && isProviderConfigPath(path)) physical.push(path);
    }
    level = next;
  }
  const treeAt = path => {
    if (path === '') return objects.commit(commit).tree;
    const parts = path.split('/'), name = parts.pop(), found = lookup(parts, name);
    return found?.type === 'directory' ? found.id : null;
  };
  const follow = (link, alias, chain, hops) => {
    if (hops > PROVIDER_LINK_LIMITS.hops) throw Object.assign(new Error(`provider configuration reaches through more than ${PROVIDER_LINK_LIMITS.hops} links in a row at ${alias}`), { providerLinkLimit: true });
    const found = resolveTreePath(lookup, link);
    if (found.unresolvable) return;
    if (found.exists && found.type === 'directory' && chain.has(found.path)) throw Object.assign(new Error(`the link ${link}, which a provider reaches as ${alias}, leads back to ${found.path === '' ? 'the repository root' : found.path}, a folder already on the way to it`), { providerLinkCycle: true, link, alias, commit });
    rows.push({ target: found.path, alias, link });
    if (!found.exists || found.type !== 'directory') return;
    const tree = treeAt(found.path); if (!tree) return;
    const inner = new Set(chain).add(found.path);
    const walk = (treeId, rel) => {
      for (const entry of objects.tree(treeId)) {
        if (++budget.entries > PROVIDER_LINK_LIMITS.entries) throw Object.assign(new Error(`provider configuration reaches more than ${PROVIDER_LINK_LIMITS.entries} entries through links`), { providerLinkLimit: true });
        const sub = rel ? `${rel}/${entry.name}` : entry.name, at = found.path ? `${found.path}/${sub}` : sub;
        if (entry.mode === TREE) walk(entry.id, sub);
        else if (entry.mode === LINK) follow(at, `${alias}/${sub}`, inner, hops + 1);
      }
    };
    walk(tree, '');
  };
  for (const path of physical) follow(path, path, new Set(), 1);
  return rows;
}

// Changed paths reached through provider-configuration links in either commit, named as the
// provider would reach them: a change to docs/report/SKILL.md through the link .agents/skills/report
// -> ../../docs/report is .agents/skills/report/SKILL.md. A path reached under several aliases is
// listed under each.
export function providerConfigChangesThroughLinks({ objects, comparison, head, changed = changedLeaves({ objects, comparison, head }) }) {
  const out = new Map();
  for (const commit of [comparison, head]) for (const row of providerConfigLinks({ objects, commit })) {
    for (const path of changed) {
      if (row.target !== '' && path !== row.target && !path.startsWith(`${row.target}/`)) continue;
      const alias = row.target === '' ? `${row.alias}/${path}` : `${row.alias}${path.slice(row.target.length)}`;
      const key = `${alias}\0${path}`;
      if (!out.has(key)) out.set(key, { alias, path, link: row.link });
    }
  }
  return [...out.values()].sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : a.path < b.path ? -1 : 1);
}

export function assertProviderConfigBoundary({ repository, objects = new VerifiedObjects(repository), task, comparison, head, where }) {
  assert(COMMIT.test(comparison ?? '') && COMMIT.test(head ?? ''), `${where}: no comparison commit is recorded for this flow, so the candidate cannot be shown to leave provider configuration unchanged`);
  const declared = declaredProviderConfig(task), changed = changedLeaves({ objects, comparison, head });
  let through;
  try { through = providerConfigChangesThroughLinks({ objects, comparison, head, changed }); }
  catch (error) {
    // A cycle, in the comparison commit or the candidate, refuses the candidate outright.
    if (error.providerLinkCycle) throw Object.assign(new Error(`${where}: the candidate ${head.slice(0, 12)} is refused: in ${error.commit === head ? 'the candidate' : `the comparison commit ${comparison.slice(0, 12)}`}, ${error.message}. Provider configuration may not contain a link cycle: what a provider loads through it has no end of names, so no declaration can be shown to cover it. Remove the link ${error.link}`), { providerConfigBoundary: [`cycle: ${error.link}`], refusal: { kind: 'provider-config-link', problem: 'cycle', link: String(error.link ?? '') } });
    if (!error.providerLinkLimit) throw error;
    throw Object.assign(new Error(`${where}: the candidate ${head.slice(0, 12)} cannot be checked: ${error.message}, so what a provider would load through them cannot be shown. Remove or shorten those links`), { providerConfigBoundary: ['links'], refusal: { kind: 'provider-config-link', problem: 'limit', link: null } });
  }
  const refused = [
    ...changed.filter(isProviderConfigPath).filter(path => !covered(path, declared)),
    ...through.filter(row => !covered(row.alias, declared)).map(row => `${row.path} (as ${row.alias}, through the link ${row.link})`),
  ];
  if (!refused.length) return;
  const shown = refused.slice(0, 5).join(', ') + (refused.length > 5 ? ` and ${refused.length - 5} more` : '');
  throw Object.assign(new Error(`${where}: the candidate ${head.slice(0, 12)} changes provider configuration (${shown}) against ${comparison.slice(0, 12)} that task ${task?.id ?? '(none)'} does not declare in its paths. Provider CLIs can load files under ${PROVIDER_CONFIG_FOLDERS.join(', ')} and ${PROVIDER_CONFIG_FILES.join(', ')}, and whatever links there reach, as configuration, skills, hooks or instructions, so a candidate changes them only when its task's paths name them as the provider reaches them (for example ".claude/skills/name"). Undo the change, or put the task again with those paths declared`), { providerConfigBoundary: refused, refusal: { kind: 'provider-config', paths: refused.slice(0, 20) } });
}
