// Knowledge upkeep: capture candidates turned into work (knowledge-upkeep design 7.4, 10.3, 11.1;
// slice 7). A capture candidate is a check, a rule or a learning the assessment proposed from a
// verified correction. A rule is a governing-context proposal (operations/upkeep-context.mjs). This
// module holds what a check or a learning task is made from:
//
//   checkScripts        which file is the script of each configured fast check, from its argv alone
//   offeredCheckScripts the scripts the factory offers at one commit: tracked, named exactly, and
//                       outside every protected set
//   learning*           the learning a learning-add task adds: its fields, its file and its place
//
// It writes nothing and starts no process. Git is read through the reader the caller passes.
//
// A check script is code the factory runs on every candidate, so what is offered is conservative.
// What is enforced is bounded and is stated as exactly that (review of 6f83d54, P2): which file a
// check task may change and its mode, and that no word of any other configured command or setting
// names that file, under any spelling or through a link, as a whole word or a token of one. It does
// not prove the script is used by nothing else: a shell string the factory cannot parse, a glob, a
// directory, an import or a sourced file can still reach it, and what the script does when it runs
// (spawn processes, source files, read its environment) is not bounded at all. That is left to the
// reviewer, the operator's own approval of the task and the manual merge decision, and to the
// containment follow-up (docs/runtime-followups.md, Containment of builder and check processes).
// What is offered:
//   - the script is identified from the command by exactly one of the two rules of 7.4; every other
//     shape (an option before the script, inline code, a module, a wrapper, an absolute or
//     versioned interpreter) offers nothing, and no argument after the script is ever eligible;
//   - the script is named in the filename policy, in no hidden folder and with no hidden name (that
//     keeps provider configuration such as .codex, .agents, .claude and .mcp.json, CI folders and
//     hook folders out), and resolves to itself: no link anywhere on its path;
//   - no other word of the configuration names it: no argument of a fast check other than its own
//     script position, and no string anywhere else in the configuration (gate checks, main checks,
//     workspace setup, preview, sources, integrations), as written, as a token of a longer string, or
//     resolved through the tree (normalization such as `checks/./x` or `a/../checks/x`, and links),
//     reaches the same file (scriptsNamedElsewhere). Which command runs, with which arguments, stays
//     the operator's configuration, which a task cannot touch (it lives outside the repository).
import { CHECK_MARKER_MAX_FILES, CHECK_SCRIPT_MODES, LEARNING_MAX_CHARS, learningChars, learningFieldProblems, plainRepositoryPath, renderLearning, safeDocsPath } from '../core/upkeep-namespace.mjs';
import { governingInTree, resolveTreePath } from '../core/tree-paths.mjs';
import { upgradeOwnedPath } from './upkeep-prefilter.mjs';

// ---- Which file is a fast check's script (7.4) ----
export const CHECK_INTERPRETERS = Object.freeze(['node', 'deno', 'bun', 'python', 'python3', 'bash', 'sh']);
const hidden = path => path.split('/').some(part => part.startsWith('.'));
// { script } or { why } for one check's argv.
export function checkScriptOf(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(item => typeof item === 'string' && item)) return { why: 'its argv is not a list of words' };
  const [first] = argv; let script, position;
  if (first.includes('/')) {
    if (first.startsWith('/')) return { why: `its command ${JSON.stringify(first.slice(0, 80))} is an absolute path` };
    if (first.split('/').includes('..')) return { why: 'its command leaves the repository through ..' };
    script = first; position = 0;
  } else if (CHECK_INTERPRETERS.includes(first)) {
    position = ['deno', 'bun'].includes(first) && argv[1] === 'run' ? 2 : 1;
    script = argv[position];
    if (script === undefined) return { why: `${first} is given no script` };
    if (script.startsWith('-')) return { why: `an option (${JSON.stringify(script.slice(0, 40))}) stands before the script, or the code is inline` };
  } else return { why: `${JSON.stringify(first.slice(0, 40))} is neither a repository path nor one of the interpreters ${CHECK_INTERPRETERS.join(', ')} (a wrapper, a versioned or absolute interpreter, or a system command offers nothing)` };
  if (!plainRepositoryPath(script) || !safeDocsPath(script)) return { why: `its script ${JSON.stringify(script.slice(0, 80))} is not a plain repository path within the filename policy` };
  if (hidden(script)) return { why: `its script ${script} is in a hidden folder or has a hidden name` };
  return { script, position };
}
// Every string in a value, at any depth.
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const names = (value, script) => value === script || value === `./${script}` || value.endsWith(`/${script}`);
// For each configured fast check: { checkId, script } or { checkId, why }. From the configuration
// alone: whether the script is a tracked file is offeredCheckScripts' question.
export function checkScripts(config) {
  const checks = Array.isArray(config?.fastChecks?.checks) ? config.fastChecks.checks : [];
  const rows = checks.map(check => ({ checkId: check?.id, ...checkScriptOf(check?.argv) }));
  const { fastChecks, ...rest } = config ?? {}, elsewhere = strings(rest);
  return rows.map(row => {
    if (!row.script) return row;
    // Used by anything else: an argument (not the script) of any fast check, or a string anywhere else.
    const asArgument = checks.some((check, index) => (Array.isArray(check?.argv) ? check.argv : []).some((word, position) => typeof word === 'string' && names(word, row.script) && !(rows[index].script === row.script && rows[index].position === position)));
    if (asArgument) return { checkId: row.checkId, why: `its script ${row.script} is also an argument of a fast check, so changing it changes another check's input` };
    if (elsewhere.some(value => names(value, row.script))) return { checkId: row.checkId, why: `its script ${row.script} is also named elsewhere in the configuration (a gate or main check, workspace setup, preview, a source or an integration), so changing it would change more than this fast check` };
    return { checkId: row.checkId, script: row.script };
  });
}
export const NO_FAST_CHECKS = 'the project has no configured fast checks: a first check needs a new script and a configuration change that adds a graph node, which is ordinary work for the operator to commission (design 10.3); decline the candidate, or do that work and then reopen it';
// Why a check candidate cannot become a check task under this configuration, before any Git is read
// ([] when it may): no fast checks, or none whose script can be identified.
export function checkConfigProblems(config) {
  const rows = checkScripts(config);
  if (!rows.length) return [NO_FAST_CHECKS];
  if (!rows.some(row => row.script)) return [`no configured fast check names a script the factory can identify, so there is nothing a check task may change: ${rows.map(row => `${row.checkId}: ${row.why}`).join('; ')}`];
  return [];
}
// The scripts, by path, with the checks they are the script of.
export function scriptsByPath(config) {
  const byPath = new Map();
  for (const row of checkScripts(config)) if (row.script) byPath.set(row.script, [...(byPath.get(row.script) ?? []), row.checkId]);
  return byPath;
}

// ---- Words of the configuration that resolve to a file (review of 6f83d54, P2) ----
// Every word the configuration could hand a command, except a fast check's own script position: each
// string outside fastChecks and each fast-check argv word, whole and split into tokens (on white
// space, quotes, `=`, `:`, `,`, `;`, parentheses), resolved in a tree (core/tree-paths.mjs), so
// `checks/./verify.mjs`, `src/../checks/verify.mjs`, `--script=checks/verify.mjs` and a link to the
// script all reach it. Absolute words are matched textually by checkScripts. Returns the resolved
// file paths, lower-cased (compared without regard to case, the conservative direction), and whether
// every word was read: past MAX_RESOLVED_WORDS the answer is incomplete and nothing is offered.
export const MAX_RESOLVED_WORDS = 4000;
const TOKENS = /[\s"'`=:,;()]+/u;
export function scriptsNamedElsewhere(config, lookup) {
  const checks = Array.isArray(config?.fastChecks?.checks) ? config.fastChecks.checks : [], rows = checks.map(check => checkScriptOf(check?.argv));
  const { fastChecks, ...rest } = config ?? {}, words = strings(rest);
  checks.forEach((check, index) => (Array.isArray(check?.argv) ? check.argv : []).forEach((word, position) => { if (typeof word === 'string' && !(rows[index].script && rows[index].position === position)) words.push(word); }));
  const seen = new Set(), files = new Set();
  for (const word of words) for (const part of [word, ...word.split(TOKENS)]) {
    if (!part || part.length > 1024 || part.includes('\0') || part.startsWith('/') || seen.has(part)) continue;
    seen.add(part); if (seen.size > MAX_RESOLVED_WORDS) return { files, complete: false };
    let found; try { found = resolveTreePath(lookup, part); } catch { continue; }
    if (!found.unresolvable && found.exists && found.type === 'file') files.add(found.path.toLowerCase());
  }
  return { files, complete: true };
}
export const NAMED_ELSEWHERE = 'another configured command or setting names the same file, under another spelling or through a link, so changing it would change more than this fast check';

// ---- What is offered at one commit ----
// `view` is the tree's lookup and protected set (core/tree-paths.mjs treeView); `owned` the
// upgrade-owned set; `learningsDir` the configured learnings directory. Returns { offered:
// [{ path, blob, mode, checks }], refused: [{ checkId?, path?, why }] }.
const inside = (directory, path) => Boolean(directory) && path.toLowerCase().startsWith(`${directory.toLowerCase().replace(/\/+$/, '')}/`);
export function offeredCheckScripts({ config, view, owned, learningsDir }) {
  const offered = [], refused = [];
  for (const row of checkScripts(config)) if (!row.script) refused.push({ checkId: row.checkId, why: row.why });
  const learnings = learningsDir ? resolveTreePath(view.lookup, learningsDir) : null, named = scriptsNamedElsewhere(config, view.lookup);
  for (const [path, checks] of scriptsByPath(config)) {
    const no = why => refused.push({ path, checks, why });
    const found = resolveTreePath(view.lookup, path);
    if (found.unresolvable) { no(`it cannot be resolved (${found.unresolvable})`); continue; }
    if (!found.exists || found.type !== 'file') { no('it is not a tracked file'); continue; }
    if (found.path !== path || found.hops) { no(`it is reached through a symbolic link (it resolves to ${found.path})`); continue; }
    const parts = path.split('/'), entry = view.lookup(parts.slice(0, -1), parts.at(-1));
    if (entry?.type !== 'file' || !CHECK_SCRIPT_MODES.includes(entry.mode)) { no('it is not an ordinary or executable regular file'); continue; }
    if (governingInTree(view.lookup, view.protected, path).governing) { no('it is governing context'); continue; }
    if (upgradeOwnedPath(owned, path)) { no('it is upgrade-owned'); continue; }
    if (learnings?.unresolvable || learnings && inside(learnings.path, path) || learningsDir && inside(learningsDir, path)) { no('it is in the learnings directory'); continue; }
    if (!named.complete) { no(`the configuration holds more than ${MAX_RESOLVED_WORDS} words, so it cannot be shown that nothing else names the script`); continue; }
    if (named.files.has(path.toLowerCase())) { no(NAMED_ELSEWHERE); continue; }
    offered.push({ path, blob: entry.id, mode: entry.mode, checks });
  }
  return { offered, refused };
}
// The files a check task declares: the ones the person named, or the script of the check the
// candidate is anchored to. Each must be offered. Returns { files } or { problem }.
export function declaredCheckFiles({ anchor, files, offered, refused }) {
  const list = offered.map(row => row.path), why = refused.map(row => `${row.path ?? row.checkId}: ${row.why}`);
  const say = what => ({ problem: `${what}. Offered scripts: ${list.length ? list.join(', ') : 'none'}${why.length ? `; not offered: ${why.join('; ')}` : ''}` });
  let wanted = files;
  if (wanted === undefined) {
    const checkId = typeof anchor === 'string' && anchor.startsWith('check:') ? anchor.slice(6) : null, own = checkId ? offered.filter(row => row.checks.includes(checkId)) : [];
    if (!own.length) return say(checkId ? `the script of fast check ${checkId}, which the candidate is anchored to, is not offered; name the scripts to change (files)` : 'the candidate is not anchored to a fast check; name the scripts to change (files)');
    wanted = own.map(row => row.path);
  }
  if (!Array.isArray(wanted) || !wanted.length || wanted.length > CHECK_MARKER_MAX_FILES || !wanted.every(path => typeof path === 'string') || new Set(wanted).size !== wanted.length) return say(`files names 1 to ${CHECK_MARKER_MAX_FILES} distinct scripts`);
  const missing = wanted.filter(path => !list.includes(path));
  if (missing.length) return say(`${missing.map(path => JSON.stringify(path.slice(0, 120))).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not the script of a configured fast check the factory can offer (an argument after a script, such as an input file, never is)`);
  return { files: wanted.map(path => offered.find(row => row.path === path)) };
}

// ---- The learning a learning-add task adds (11.1) ----
export const learningIdOf = findingId => `learning-${String(findingId).replace(/[^a-f0-9]/g, '').slice(0, 12).padEnd(12, '0')}`;
// The paths a learning applies to: the directory it is anchored to, or the globs a person named.
export function learningPathsOf(anchor, paths) {
  if (paths !== undefined) return { paths };
  if (typeof anchor === 'string' && anchor.startsWith('dir:') && plainRepositoryPath(anchor.slice(4))) return { paths: [`${anchor.slice(4)}/**`] };
  return { problem: `the candidate is anchored to ${JSON.stringify(String(anchor).slice(0, 80))}, not to a directory, so the files it applies to are not known; name them (paths: repository-relative globs)` };
}
export function learningFields({ row, dir, paths, today }) {
  const id = learningIdOf(row.id);
  return { dir, path: `${dir}/${id}.md`, id, title: row.title, paths, kind: row.topic, enforced_by: 'none', last_verified: today, retire_when: 'none', body: typeof row.text === 'string' ? row.text : '' };
}
// Why these fields cannot be written as one learning file ([] when they can).
export function learningProblems(fields) {
  const problems = learningFieldProblems(fields);
  if (!problems.length && !safeDocsPath(fields.path)) problems.push('the learning file name is outside the filename policy');
  if (!problems.length) { const size = learningChars(renderLearning(fields)); if (size > LEARNING_MAX_CHARS) problems.push(`the learning file, frontmatter and title included, would be ${size} characters; a learning is at most ${LEARNING_MAX_CHARS}`); }
  return problems;
}
