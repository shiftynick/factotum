// Knowledge upkeep, slice 1: path resolution in a Git tree and the protected set (design 7.1).
// Every fixture is fictional. Each runs against an in-memory tree and against the same tree
// written as Git objects and read back through hash-verified objects; where the file system can
// hold the tree, the result is also compared with what the file system itself resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAX_LINK_HOPS, resolveTreePath, gitTreeLookup, gitCommitLookup, protectedSet, governingInTree, governingAcross, treeView } from '../starter/factory/core/tree-paths.mjs';
import { VerifiedObjects } from '../starter/factory/core/verified-git.mjs';
import { assembleContext } from '../starter/factory/operations/context.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';

const link = target => ({ link: target }), SUBMODULE = { submodule: true };
const isLink = entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'link'), isSubmodule = entry => entry === SUBMODULE;
function memoryLookup(tree) {
  return (directories, name) => {
    let node = tree; for (const directory of directories) node = node[directory];
    if (!Object.hasOwn(node, name)) return null;
    const entry = node[name];
    return typeof entry === 'string' ? { type: 'file' } : isLink(entry) ? { type: 'link', target: entry.link } : isSubmodule(entry) ? { type: 'submodule' } : { type: 'directory' };
  };
}
// One repository for the whole file; every fixture tree is written as objects (no worktree).
let repository;
function repo(t) {
  if (repository) return repository;
  const dir = mkdtempSync(join(tmpdir(), 'fct-tree-')); repository = { dir, objects: null };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['config', 'commit.gpgsign', 'false']]) execFileSync('git', args, { cwd: dir });
  repository.objects = new VerifiedObjects(dir);
  return repository;
}
test.after(() => { if (repository) rmSync(repository.dir, { recursive: true, force: true }); });
const git = (dir, args, input) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' }).trim();
function writeTree(dir, tree) {
  const lines = Object.entries(tree).map(([name, entry]) => {
    if (typeof entry === 'string') return `100644 blob ${git(dir, ['hash-object', '-w', '--stdin'], entry)}\t${name}`;
    if (isLink(entry)) return `120000 blob ${git(dir, ['hash-object', '-w', '--stdin'], entry.link)}\t${name}`;
    if (isSubmodule(entry)) return `160000 commit ${'1'.repeat(40)}\t${name}`;
    return `040000 tree ${writeTree(dir, entry)}\t${name}`;
  });
  return git(dir, ['mktree', '--missing'], lines.length ? lines.join('\n') + '\n' : '');
}
const gitLookup = (t, tree) => { const r = repo(t); return gitTreeLookup(r.objects, writeTree(r.dir, tree)); };
// The same tree on disk, for what the file system itself says. Not for trees with a submodule.
function onDisk(t, tree) {
  const root = mkdtempSync(join(tmpdir(), 'fct-fs-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (at, node) => { for (const [name, entry] of Object.entries(node)) { const path = join(at, name); if (typeof entry === 'string') writeFileSync(path, entry); else if (isLink(entry)) symlinkSync(entry.link, path); else { mkdirSync(path); write(path, entry); } } };
  write(root, tree); return realpathSync(root);
}
// What the kernel resolves: realpath(3) on the path exactly as written. Neither path.join nor Node's
// own realpathSync is used, because both cancel `name/..` as text.
const fileSystemPath = (root, path) => { try { const real = realpathSync.native(`${root}/${path}`), rel = relative(root, real); return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')) ? rel : { outside: true }; } catch (error) { return { error: error.code }; } };
const hasSubmodule = tree => Object.values(tree).some(entry => isSubmodule(entry) || (entry && typeof entry === 'object' && !isLink(entry) && hasSubmodule(entry)));

// What the context loader (operations/context.mjs) delivers for one governing entry of a tree on
// disk: the file's text, or null when the entry is omitted as unavailable or outside the project.
function loaded(root, path) {
  const context = assembleContext({ repoRoot: root, config: { maxChars: 1000000, files: [{ id: 'entry', path }] } });
  if (context.files.length) return context.files[0].text;
  assert.deepEqual(context.omitted, [{ id: 'entry', reason: 'unavailable or outside project' }]); return null;
}
// The content of the file at a resolved path of a fixture tree (a resolved path passes no link).
const contentAt = (tree, path) => path.split('/').reduce((node, name) => node[name], tree);
// Resolve `path` in `tree` with both readers; they must agree. Where the path exists on disk, the
// file system must agree too, and where the resolver says the path leaves the repository or
// cannot be followed, the file system must not have found a file inside the root. And the context
// loader must agree with the resolver: it delivers exactly the file the resolver names, and
// nothing where the resolver finds no file. `agreements` counts those comparisons.
let agreements = 0;
function resolveBoth(t, tree, path) {
  const memory = resolveTreePath(memoryLookup(tree), path), fromGit = resolveTreePath(gitLookup(t, tree), path);
  assert.deepEqual(fromGit, memory, `the Git tree and the in-memory tree resolve ${path} alike`);
  if (!hasSubmodule(tree)) {
    const root = onDisk(t, tree), real = fileSystemPath(root, path);
    if (memory.exists) assert.equal(real, memory.path, `the file system resolves ${path} to the same place`);
    else assert.ok(typeof real !== 'string', `the file system finds nothing at ${path} (${JSON.stringify(real)}), and the resolver says ${JSON.stringify(memory)}`);
    const text = loaded(root, path);
    if (memory.exists && memory.type === 'file') assert.equal(text, contentAt(tree, memory.path), `the context loader delivers ${memory.path} for the entry ${path}`);
    else assert.equal(text, null, `the context loader delivers nothing for the entry ${path}, which the resolver places at ${JSON.stringify(memory)}`);
    agreements++;
  }
  return memory;
}
const resolved = (t, tree, path) => { const found = resolveBoth(t, tree, path); assert.equal(found.unresolvable, undefined, `${path}: ${found.unresolvable}`); return found.path; };
const refused = (t, tree, path, reason) => { const found = resolveBoth(t, tree, path); assert.match(found.unresolvable ?? `resolved to ${found.path}`, reason, path); };
const views = (t, tree, context) => [treeView(memoryLookup(tree), context), treeView(gitLookup(t, tree), context)];
const governing = (t, tree, context, path) => { const [a, b] = views(t, tree, context).map(view => governingInTree(view.lookup, view.protected, path)); assert.deepEqual(b, a, `both readers agree on ${path}`); return a; };
const rules = (...paths) => ({ files: paths.map((path, index) => ({ id: `rule-${index}`, path })) });

test('a plain tree: files, directories, `.`, empty components, `..`, case and what does not exist', t => {
  const tree = { 'README.md': 'readme', docs: { 'guide.md': 'guide', api: { 'index.md': 'api' } }, src: { 'main.js': 'code' } };
  assert.equal(resolved(t, tree, 'README.md'), 'README.md');
  assert.equal(resolved(t, tree, './README.md'), 'README.md');
  assert.equal(resolved(t, tree, 'docs/../README.md'), 'README.md');
  assert.equal(resolved(t, tree, 'docs//api/./index.md'), 'docs/api/index.md');
  assert.equal(resolved(t, tree, 'docs/api/../guide.md'), 'docs/guide.md');
  assert.deepEqual(resolveBoth(t, tree, 'docs/api'), { path: 'docs/api', exists: true, type: 'directory', hops: 0 });
  assert.deepEqual(resolveBoth(t, tree, 'docs/api/'), { path: 'docs/api', exists: true, type: 'directory', hops: 0 });
  assert.deepEqual(resolveBoth(t, tree, '.'), { path: '', exists: true, type: 'directory', hops: 0 });
  // Lookups use exact names: another letter case is a different, missing name. It resolves to where it would be.
  assert.deepEqual(resolveBoth(t, tree, 'readme.md'), { path: 'readme.md', exists: false, hops: 0 });
  assert.deepEqual(resolveBoth(t, tree, 'docs/new/later.md'), { path: 'docs/new/later.md', exists: false, hops: 0 });
  // An ordinary file with components after it is treated as missing.
  assert.deepEqual(resolveBoth(t, tree, 'README.md/inside.md'), { path: 'README.md/inside.md', exists: false, hops: 0 });
  assert.deepEqual(resolveBoth(t, tree, 'README.md/'), { path: 'README.md', exists: false, hops: 0 });
  // `..` is applied only to what has been resolved: after a missing component nothing can be said.
  refused(t, tree, 'missing/../README.md', /does not exist/);
  refused(t, tree, 'README.md/../docs/guide.md', /does not exist/);
  refused(t, tree, '../outside.md', /leaves the repository/);
  refused(t, tree, 'docs/../../outside.md', /leaves the repository/);
  for (const path of ['/etc/passwd', '/README.md']) assert.match(resolveTreePath(memoryLookup(tree), path).unresolvable, /absolute/);
  for (const path of ['', null, undefined, 'a\0b', 7]) assert.match(resolveTreePath(memoryLookup(tree), path).unresolvable, /not a path/);
});

test('links: a file that is a link, a linked parent and grandparent, chains of two and three, `..` in a target, a linked directory that contains a link', t => {
  const tree = {
    'AGENTS.md': 'rules',
    docs: { 'AGENTS.md': 'docs rules', 'rules.md': link('../AGENTS.md'), deep: { 'note.md': 'note', again: link('../../shared') } },
    rules: { current: link('../docs') },
    shared: { 'policy.md': 'policy', inner: link('../docs/deep') },
    grand: link('shared'),
    two: link('three'), three: link('docs'),
    one: link('two'),
  };
  assert.equal(resolved(t, tree, 'docs/rules.md'), 'AGENTS.md', 'a file that is itself a link');
  assert.equal(resolved(t, tree, 'rules/current/AGENTS.md'), 'docs/AGENTS.md', 'a link in the parent directory (the design\'s first example)');
  assert.equal(resolved(t, tree, 'grand/inner/note.md'), 'docs/deep/note.md', 'a link in the grandparent directory, to a directory that contains a link');
  assert.equal(resolved(t, tree, 'two/AGENTS.md'), 'docs/AGENTS.md', 'a chain of two links');
  assert.equal(resolved(t, tree, 'one/AGENTS.md'), 'docs/AGENTS.md', 'a chain of three links');
  assert.equal(resolved(t, tree, 'docs/deep/again/policy.md'), 'shared/policy.md', 'a relative target that uses `..`');
  assert.equal(resolved(t, tree, 'one/deep/again/inner/again/policy.md'), 'shared/policy.md', 'links met while walking a link\'s target');
  assert.equal(resolveBoth(t, tree, 'one/AGENTS.md').hops, 3);
  // A link to something that does not exist resolves to where it points, marked missing.
  const dangling = { docs: { 'gone.md': link('../nowhere/file.md') } };
  assert.deepEqual(resolveBoth(t, dangling, 'docs/gone.md'), { path: 'nowhere/file.md', exists: false, hops: 1 });
});

test('a target whose `..` follows a link is walked component by component (the worked example)', t => {
  const tree = { rules: link('docs/jump/..'), docs: { jump: link('../private/subdir'), 'AGENTS.md': 'not the governing file' }, private: { subdir: { 'other.md': 'x' }, 'AGENTS.md': 'the governing file' } };
  // docs, then jump (a link to ../private/subdir), then `..` leaves subdir: private/AGENTS.md.
  // Cancelling `jump/..` as text would have given docs/AGENTS.md.
  assert.equal(resolved(t, tree, 'rules/AGENTS.md'), 'private/AGENTS.md');
  const context = rules('rules/AGENTS.md');
  assert.deepEqual(governing(t, tree, context, 'private/AGENTS.md'), { governing: true, protectedFile: true, reason: 'protected', path: 'private/AGENTS.md' });
  assert.deepEqual(governing(t, tree, context, 'docs/AGENTS.md'), { governing: false, protectedFile: false, path: 'docs/AGENTS.md' }, 'docs/AGENTS.md is not the governing file on that account');
});

test('fail closed: an escape hidden by early cancellation, a cycle, an absolute target, a target that leaves the root, a submodule', t => {
  // rules -> sub/hop/../x and sub/hop -> ../.. : walking it leaves the repository at hop.
  // Cancelling `hop/..` as text would have given sub/x.
  const hidden = { rules: link('sub/hop/../x'), sub: { hop: link('../..'), x: { 'AGENTS.md': 'looks governing' } }, docs: { 'guide.md': 'guide' } };
  refused(t, hidden, 'rules/AGENTS.md', /leaves the repository/);
  const cycle = { a: link('b'), b: link('a'), loop: link('loop'), docs: { 'guide.md': 'guide' } };
  refused(t, cycle, 'a/AGENTS.md', /symbolic links/); refused(t, cycle, 'loop', /symbolic links/);
  // An absolute target, to a directory and to a file that exists outside the repository.
  const absolute = { rules: link('/etc'), passwd: link('/etc/passwd'), docs: { 'guide.md': 'guide' } };
  refused(t, absolute, 'rules/AGENTS.md', /absolute target/); refused(t, absolute, 'rules/passwd', /absolute target/); refused(t, absolute, 'passwd', /absolute target/);
  const leaves = { rules: link('../elsewhere'), docs: { 'guide.md': 'guide' } };
  refused(t, leaves, 'rules/AGENTS.md', /leaves the repository/);
  const submodule = { vendor: SUBMODULE, rules: link('vendor/rules'), docs: { 'guide.md': 'guide' } };
  refused(t, submodule, 'vendor/AGENTS.md', /submodule/); refused(t, submodule, 'rules/AGENTS.md', /submodule/);
  const empty = { rules: link(''), docs: { 'guide.md': 'guide' } };
  assert.match(resolveTreePath(memoryLookup(empty), 'rules/AGENTS.md').unresolvable, /cannot be read/);
  // An unresolvable governing entry: nothing in that tree can be shown to be outside the protected
  // set, so every path counts as governing, including an ordinary document nowhere near the link.
  for (const [tree, entry] of [[hidden, 'rules/AGENTS.md'], [cycle, 'a/AGENTS.md'], [absolute, 'rules/AGENTS.md'], [leaves, 'rules/AGENTS.md'], [submodule, 'rules/AGENTS.md']]) {
    const answer = governingInTree(memoryLookup(tree), protectedSet(memoryLookup(tree), rules(entry)), 'docs/guide.md');
    assert.equal(answer.governing, true); assert.equal(answer.protectedFile, false); assert.equal(answer.reason, 'governing-unresolvable'); assert.equal(answer.entries[0].path, entry);
    const fromGit = gitLookup(t, tree); assert.equal(governingInTree(fromGit, protectedSet(fromGit, rules(entry)), 'docs/guide.md').reason, 'governing-unresolvable');
  }
  // A document path that cannot be resolved is governing too, though every governing entry resolves.
  assert.deepEqual(governing(t, hidden, rules('docs/guide.md'), 'rules/AGENTS.md'), { governing: true, protectedFile: false, reason: 'unresolvable', detail: 'the path leaves the repository' });
});

test(`a chain of ${MAX_LINK_HOPS} links resolves and one more does not`, t => {
  const chain = length => Object.fromEntries([['target.md', 'end'], ...Array.from({ length }, (_, index) => [`l${index}`, link(index + 1 === length ? 'target.md' : `l${index + 1}`)])]);
  // The kernel's own limit is the same: the file system and the context loader stop where the resolver does.
  assert.deepEqual(resolveBoth(t, chain(MAX_LINK_HOPS), 'l0'), { path: 'target.md', exists: true, type: 'file', hops: MAX_LINK_HOPS });
  refused(t, chain(MAX_LINK_HOPS + 1), 'l0', /symbolic links/);
});

test('the protected set: the same file written three ways, an entry that does not exist, and a file listed as both a document and governing', t => {
  const tree = { 'README.md': 'readme', docs: { 'guide.md': 'guide', api: { 'RULES.md': 'api rules', 'index.md': 'api' } } };
  // An entry whose file does not exist is still protected: creating it must not be a docs edit.
  const context = rules('README.md', 'docs/api/RULES.md', 'docs/planned/later.md');
  const set = protectedSet(memoryLookup(tree), context);
  assert.deepEqual([...set.paths].sort(), ['docs/api/rules.md', 'docs/planned/later.md', 'readme.md']); assert.equal(set.complete, true);
  // A file in both upkeep.docs.include and context.files, and one a docs map glob covers: governing, whatever lists it.
  for (const path of ['README.md', './README.md', 'docs/../README.md', 'readme.md', 'ReadMe.MD', 'docs/api/RULES.md', 'docs/api/rules.md', 'DOCS/API/RULES.md', 'docs/planned/later.md', 'docs/Planned/Later.md'])
    assert.equal(governing(t, tree, context, path).governing, true, `${path} is governing`);
  for (const path of ['docs/guide.md', 'docs/api/index.md', 'docs/planned/other.md', 'README.md.bak'])
    assert.deepEqual(governing(t, tree, context, path), { governing: false, protectedFile: false, path }, `${path} is not governing`);
  // The configured entry written with `./`, `..` or in another case protects the same file.
  for (const written of ['./README.md', 'docs/../README.md', 'readme.MD']) assert.equal(governing(t, tree, rules(written), 'README.md').governing, true, written);
  assert.deepEqual(protectedSet(memoryLookup(tree), {}).paths.size, 0); assert.equal(protectedSet(memoryLookup(tree), undefined).complete, true);
});

// Both directions, with the link in the comparison tree, in the candidate's tree and in both.
const DIRECTIONS = [
  { name: 'a governing entry that leads to a document\'s location, through a linked parent directory', context: rules('rules/current/AGENTS.md'), path: 'docs/AGENTS.md',
    plain: { rules: { current: { 'AGENTS.md': 'real rules' } }, docs: { 'AGENTS.md': 'a document' } }, linked: { rules: { current: link('../docs') }, docs: { 'AGENTS.md': 'a document' } } },
  { name: 'a governing entry that leads to a document through a chain of three links and a `..`', context: rules('rules/AGENTS.md'), path: 'docs/handbook/AGENTS.md',
    plain: { rules: { 'AGENTS.md': 'real rules' }, docs: { handbook: { 'AGENTS.md': 'a document' } } }, linked: { rules: link('hop1'), hop1: link('hop2/..'), hop2: link('docs/handbook/inner'), docs: { handbook: { inner: {}, 'AGENTS.md': 'a document' } } } },
  { name: 'a document path that is itself a link to the governing file', context: rules('AGENTS.md'), path: 'docs/rules.md',
    plain: { 'AGENTS.md': 'rules', docs: { 'rules.md': 'a document' } }, linked: { 'AGENTS.md': 'rules', docs: { 'rules.md': link('../AGENTS.md') } } },
  { name: 'a document path that reaches the governing file through a linked parent directory', context: rules('governance/AGENTS.md'), path: 'docs/shared/AGENTS.md',
    plain: { governance: { 'AGENTS.md': 'rules' }, docs: { shared: { 'AGENTS.md': 'a document' } } }, linked: { governance: { 'AGENTS.md': 'rules' }, docs: { shared: link('../governance') } } },
  { name: 'a document path that reaches the governing file through a linked grandparent and two hops', context: rules('governance/team/AGENTS.md'), path: 'handbook/team/AGENTS.md',
    plain: { governance: { team: { 'AGENTS.md': 'rules' } }, handbook: { team: { 'AGENTS.md': 'a document' } } }, linked: { governance: { team: { 'AGENTS.md': 'rules' } }, handbook: link('alias'), alias: link('governance') } },
  { name: 'a document path in another letter case than the governing entry', context: rules('Docs/Rules.md'), path: 'docs/rules.md',
    plain: { docs: { 'rules.md': 'a document' }, other: { 'x.md': 'x' } }, linked: { docs: { 'rules.md': 'a document' }, other: { 'x.md': 'x' } }, caseOnly: true },
];
for (const direction of DIRECTIONS) test(`both trees: ${direction.name}`, t => {
  const { context, path, plain, linked } = direction, view = tree => views(t, tree, context);
  const [plainMemory, plainGit] = view(plain), [linkedMemory, linkedGit] = view(linked);
  for (const [base, candidate, label] of [[linkedMemory, plainMemory, 'the comparison tree only'], [plainMemory, linkedMemory, 'the candidate\'s tree only'], [linkedMemory, linkedMemory, 'both trees'], [linkedGit, plainGit, 'the comparison tree only (Git)'], [plainGit, linkedGit, 'the candidate\'s tree only (Git)'], [linkedGit, linkedGit, 'both trees (Git)']]) {
    const answer = governingAcross([base, candidate], path);
    assert.equal(answer.either, true, `the link in ${label}: ${path} is governing in one of the trees`);
    // A context task needs the path to be a protected file in both trees; a link in only one is not that.
    // Nor is a file the entry names only in another letter case: it is governing, and the loader delivers nothing for that entry.
    assert.equal(answer.both, !direction.caseOnly && base === candidate, `the link in ${label}: a protected file in both trees`);
  }
  // In each tree, the context loader delivers for the governing entry and for the document path exactly the file the resolver names.
  for (const tree of [plain, linked]) for (const entry of [...context.files.map(file => file.path), path]) resolveBoth(t, tree, entry);
  // With the link in neither tree the document is an ordinary document.
  assert.deepEqual(governingAcross([plainMemory, plainMemory], path).either, direction.caseOnly === true);
  assert.deepEqual(governingAcross([plainGit, plainGit], path).either, direction.caseOnly === true);
});

// The strict answer (protectedFile, and `both` across two trees) is what would let a context task
// change a path. It must hold only where the tree has a regular file there that a governing entry
// reaches, which is where the context loader delivers a file. `governing` stays conservative.
test('a protected path that is missing, a directory, or a file followed by `/` is governing but not a protected file', t => {
  // The smallest case: a tree with nothing in it.
  const empty = treeView(() => null, rules('missing.md'));
  assert.deepEqual(governingInTree(empty.lookup, empty.protected, 'missing.md'), { governing: true, protectedFile: false, reason: 'protected', path: 'missing.md' });
  assert.deepEqual((({ either, both }) => ({ either, both }))(governingAcross([empty, empty], 'missing.md')), { either: true, both: false });
  const tree = { 'README.md': 'readme', rules: { 'inner.md': 'inner' }, 'rules.md': 'the rules', docs: { 'guide.md': 'guide' } }, root = onDisk(t, tree);
  const cases = [
    // [the governing entry as configured, the path asked about, what the entry delivers]
    ['missing.md', 'missing.md', null], ['docs/later/new.md', 'docs/later/new.md', null],
    ['rules', 'rules', null], ['rules', 'rules/', null], ['rules/', 'rules', null], ['docs/..', '.', null],
    ['rules.md/', 'rules.md/', null], ['rules.md/', 'rules.md', null], ['rules.md/.', 'rules.md', null], ['rules.md/inner', 'rules.md/inner', null],
    ['RULES.md', 'rules.md', null], ['rules.md', 'RULES.md', 'the rules'], ['Docs/Guide.md', 'docs/guide.md', null],
  ];
  for (const [entry, path, delivered] of cases) {
    const answer = governing(t, tree, rules(entry), path);
    assert.equal(answer.governing, true, `${entry} protects ${path}`); assert.equal(answer.reason, 'protected');
    assert.equal(answer.protectedFile, false, `the entry ${entry} does not make ${path} a protected file`);
    assert.equal(loaded(root, entry), delivered, `what the loader delivers for the entry ${entry}`);
    for (const [a, b] of [views(t, tree, rules(entry))]) for (const view of [a, b]) assert.equal(governingAcross([view, view], path).both, false, `${entry} ${path}`);
  }
  // The control: a regular file an entry reaches is a protected file, however the entry or the path is written.
  for (const [entry, path] of [['rules.md', 'rules.md'], ['./rules.md', 'rules.md'], ['rules.md', 'rules/../rules.md'], ['docs/../rules.md', './rules.md'], ['docs/guide.md', 'docs/guide.md']]) {
    assert.deepEqual(governing(t, tree, rules(entry), path), { governing: true, protectedFile: true, reason: 'protected', path: entry.includes('guide') ? 'docs/guide.md' : 'rules.md' }, `${entry} ${path}`);
    assert.equal(typeof loaded(root, entry), 'string');
  }
  // One entry that reaches the file is enough, beside one that does not.
  assert.equal(governing(t, tree, rules('rules.md/', 'rules.md'), 'rules.md').protectedFile, true); assert.equal(governing(t, tree, rules('rules.md/', 'RULES.md'), 'rules.md').protectedFile, false);
  // The protected set says which paths are files an entry delivers.
  const set = protectedSet(memoryLookup(tree), rules('rules.md', 'rules', 'missing.md', 'rules.md/', 'RULES.md'));
  assert.deepEqual([...set.paths].sort(), ['missing.md', 'rules', 'rules.md']); assert.deepEqual([...set.files], ['rules.md']);
});

test('mixed trees: a regular file in one tree and missing, a directory or a dangling link in the other is not a protected file in both', t => {
  const context = rules('rules.md'), path = 'rules.md';
  const trees = {
    regular: { 'rules.md': 'the rules', other: { 'x.md': 'x' } },
    linked: { 'rules.md': link('real/rules.md'), real: { 'rules.md': 'the rules' } },
    missing: { other: { 'x.md': 'x' } },
    directory: { 'rules.md': { 'inner.md': 'inner' } },
    dangling: { 'rules.md': link('gone.md'), other: { 'x.md': 'x' } },
    linkedDirectory: { 'rules.md': link('other'), other: { 'x.md': 'x' } },
  };
  const delivered = { regular: 'the rules', linked: 'the rules', missing: null, directory: null, dangling: null, linkedDirectory: null };
  const made = Object.fromEntries(Object.entries(trees).map(([name, tree]) => [name, views(t, tree, context)]));
  for (const [name, tree] of Object.entries(trees)) {
    assert.equal(loaded(onDisk(t, tree), path), delivered[name], `${name}: what the loader delivers`);
    for (const view of made[name]) { const answer = governingInTree(view.lookup, view.protected, path); assert.equal(answer.governing, true, name); assert.equal(answer.protectedFile, delivered[name] !== null, `${name}: a protected file exactly where a file is delivered`); }
  }
  const files = ['regular', 'linked'], others = ['missing', 'directory', 'dangling', 'linkedDirectory'];
  for (const reader of [0, 1]) {
    const both = (a, b) => { const answer = governingAcross([made[a][reader], made[b][reader]], path); assert.equal(answer.either, true, `${a} and ${b}`); return answer.both; };
    for (const file of files) for (const other of others) { assert.equal(both(file, other), false, `${file} then ${other}`); assert.equal(both(other, file), false, `${other} then ${file}`); }
    for (const a of others) for (const b of others) assert.equal(both(a, b), false, `${a} then ${b}`);
    for (const a of files) for (const b of files) assert.equal(both(a, b), true, `${a} then ${b}: a regular file in both trees`);
  }
});

test('a candidate that makes a governing entry unresolvable fails closed for every path of that tree', t => {
  const context = rules('rules/AGENTS.md');
  const base = treeView(memoryLookup({ rules: { 'AGENTS.md': 'rules' }, docs: { 'guide.md': 'guide' } }), context);
  const candidate = treeView(memoryLookup({ rules: link('rules'), docs: { 'guide.md': 'guide' } }), context);
  assert.equal(governingInTree(base.lookup, base.protected, 'docs/guide.md').governing, false);
  const answer = governingAcross([base, candidate], 'docs/guide.md');
  assert.equal(answer.either, true); assert.equal(answer.both, false); assert.equal(answer.results[1].reason, 'governing-unresolvable');
});

test('a context entry added by a configuration change makes the path governing with the configuration current at the check', t => {
  const tree = { 'AGENTS.md': 'rules', docs: { 'guide.md': 'guide', 'style.md': 'style' } }, lookup = memoryLookup(tree);
  const before = rules('AGENTS.md'), after = rules('AGENTS.md', 'docs/style.md');
  assert.equal(governingInTree(lookup, protectedSet(lookup, before), 'docs/style.md').governing, false);
  assert.equal(governingInTree(lookup, protectedSet(lookup, after), 'docs/style.md').governing, true);
  assert.equal(governingInTree(lookup, protectedSet(lookup, after), 'docs/guide.md').governing, false);
});

test('a real commit with a symbolic link and a submodule entry is read through verified objects', t => {
  const root = mkdtempSync(join(tmpdir(), 'fct-commit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['config', 'commit.gpgsign', 'false']]) execFileSync('git', args, { cwd: root });
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'rules')); writeFileSync(join(root, 'docs', 'AGENTS.md'), 'rules\n'); writeFileSync(join(root, 'README.md'), 'readme\n');
  symlinkSync('../docs', join(root, 'rules', 'current'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},vendor/library`], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'Fictional tree'], { cwd: root });
  const head = git(root, ['rev-parse', 'HEAD']), lookup = gitCommitLookup(new VerifiedObjects(root), head);
  assert.deepEqual(resolveTreePath(lookup, 'rules/current/AGENTS.md'), { path: 'docs/AGENTS.md', exists: true, type: 'file', hops: 1 });
  assert.equal(relative(realpathSync(root), realpathSync.native(`${root}/rules/current/AGENTS.md`)), 'docs/AGENTS.md', 'as the file system resolves it');
  assert.match(resolveTreePath(lookup, 'vendor/library/README.md').unresolvable, /submodule/);
  const view = treeView(lookup, rules('rules/current/AGENTS.md'));
  assert.equal(governingInTree(view.lookup, view.protected, 'docs/AGENTS.md').protectedFile, true);
  assert.equal(governingInTree(view.lookup, view.protected, 'README.md').governing, false);
});

// ---- The context loader resolves as the kernel does, and so as the resolver does ----
// operations/context.mjs readEntry used Node's realpathSync on a path.resolve()d path, and both
// cancel `name/..` as text, in the configured path and in a link's target. It now asks realpath(3)
// for the path exactly as written.
const WORKED = { rules: link('docs/jump/..'), docs: { jump: link('../private/subdir'), 'AGENTS.md': 'the docs copy' }, private: { subdir: { 'other.md': 'x' }, 'AGENTS.md': 'the private copy' } };
const deliver = (root, files, changedPaths) => assembleContext({ repoRoot: root, config: { maxChars: 100000, files }, changedPaths });

test('the worked example: the loader delivers private/AGENTS.md, which the resolver protects', t => {
  const root = onDisk(t, WORKED);
  assert.equal(resolveTreePath(memoryLookup(WORKED), 'rules/AGENTS.md').path, 'private/AGENTS.md');
  assert.equal(readFileSync(`${root}/rules/AGENTS.md`, 'utf8'), 'the private copy', 'what opening the path reads');
  const context = deliver(root, [{ id: 'rules', path: 'rules/AGENTS.md', required: true }]);
  assert.deepEqual(context.files.map(file => [file.id, file.path, file.text]), [['rules', 'rules/AGENTS.md', 'the private copy']]); assert.deepEqual(context.omitted, []);
  // What the loader did before: Node's realpathSync cancels jump/.. in the link target and lands on the docs copy.
  assert.equal(relative(root, realpathSync(`${root}/rules/AGENTS.md`)), 'docs/AGENTS.md');
  // The same for a `..` after a link in the configured path itself.
  const inPath = { docs: { jump: link('../private/subdir'), 'AGENTS.md': 'the docs copy' }, private: { subdir: {}, 'AGENTS.md': 'the private copy' } };
  assert.equal(resolved(t, inPath, 'docs/jump/../AGENTS.md'), 'private/AGENTS.md');
  assert.deepEqual(deliver(onDisk(t, inPath), [{ id: 'rules', path: 'docs/jump/../AGENTS.md', required: true }]).files.map(file => file.text), ['the private copy']);
});

test('an ordinary path is delivered as before: the same file, the same text, the same digests', t => {
  const tree = { 'AGENTS.md': 'root rules', project: { 'GOVERNANCE.md': 'project rules', sub: { 'notes.md': 'notes' } }, rules: { current: link('../project') }, alias: link('AGENTS.md') };
  const root = onDisk(t, tree), files = ['AGENTS.md', './AGENTS.md', 'project/GOVERNANCE.md', 'project/sub/../GOVERNANCE.md', 'project//sub/./notes.md', 'rules/current/GOVERNANCE.md', 'alias', `${root}/AGENTS.md`].map((path, index) => ({ id: `entry-${index}`, path }));
  // As the loader read an entry before this change.
  const before = path => readFileSync(realpathSync(resolve(root, path)), 'utf8');
  const context = deliver(root, files);
  assert.deepEqual(context.omitted, []); assert.deepEqual(context.files.map(file => file.text), files.map(file => before(file.path)));
  assert.deepEqual(context.files.map(file => file.text), ['root rules', 'root rules', 'project rules', 'project rules', 'notes', 'project rules', 'root rules', 'root rules']);
  // The package is what it was: same order, same per-file digests, same package digest for the same texts.
  assert.deepEqual(context.files.map(file => file.digest), files.map(file => digest(before(file.path))));
  assert.equal(context.digest, digest({ files: context.files, omitted: [] })); assert.equal(context.chars, context.files.reduce((sum, file) => sum + file.text.length, 0));
  // The budget still applies, and a required entry over it still fails.
  const tight = assembleContext({ repoRoot: root, config: { maxChars: 12, files: [{ id: 'a', path: 'AGENTS.md' }, { id: 'b', path: 'project/GOVERNANCE.md' }] } });
  assert.deepEqual(tight.files.map(file => file.id), ['a']); assert.deepEqual(tight.omitted, [{ id: 'b', reason: 'budget exhausted' }]);
  assert.throws(() => assembleContext({ repoRoot: root, config: { maxChars: 5, files: [{ id: 'a', path: 'AGENTS.md', required: true }] } }), /required context exceeds budget/);
});

test('an escape is still refused: through a link followed by `..`, through a link, and by `..` alone', t => {
  // Outside the project: a directory beside it, holding a file that must never be delivered.
  const outside = mkdtempSync(join(tmpdir(), 'fct-out-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, 'inner')); writeFileSync(join(outside, 'secret.md'), 'outside the project'); writeFileSync(join(outside, 'inner', 'deep.md'), 'outside the project');
  const real = realpathSync(outside);
  // docs/out is a link to a directory outside. `docs/out/../secret.md` reaches the outside file through the
  // link; cancelled as text it would have named docs/secret.md, an innocent file inside the project.
  const tree = { docs: { out: link(`${real}/inner`), 'secret.md': 'the decoy inside the project' }, 'AGENTS.md': 'rules', sub: { hop: link('../..'), x: { 'AGENTS.md': 'looks governing' } }, hidden: link('sub/hop/../x') };
  const root = onDisk(t, tree);
  assert.equal(readFileSync(`${root}/docs/out/../secret.md`, 'utf8'), 'outside the project', 'the kernel follows the link first');
  for (const path of ['docs/out/../secret.md', 'docs/out/deep.md', '../' + real.split('/').at(-1) + '/secret.md', `${real}/secret.md`, 'hidden/AGENTS.md', 'sub/hop/AGENTS.md']) {
    assert.deepEqual(deliver(root, [{ id: 'entry', path }]).omitted, [{ id: 'entry', reason: 'unavailable or outside project' }], path);
    assert.throws(() => deliver(root, [{ id: 'entry', path, required: true }]), /required context unavailable: entry/, path);
  }
  assert.throws(() => deliver(root, [{ id: 'entry', path: 'docs/out/../secret.md', required: true }]), /context must stay inside project root/);
  // The root itself, a directory, and a path that is not one are not files to deliver.
  for (const path of ['.', '', 'docs', 'docs/', 'AGENTS.md/', 'AGENTS.md/.', 'missing/../AGENTS.md', 'a\0b']) assert.deepEqual(deliver(root, [{ id: 'entry', path }]).files, [], JSON.stringify(path));
  assert.throws(() => deliver(root, [{ id: 'entry', path: 'docs', required: true }]), /context must be a regular file/);
  // The resolver refuses the same entries, so the protected set of this tree fails closed for them.
  for (const path of ['docs/out/../secret.md', 'docs/out/deep.md', 'hidden/AGENTS.md', 'sub/hop/AGENTS.md', '../x/secret.md', `${real}/secret.md`]) assert.ok(resolveTreePath(memoryLookup(tree), path).unresolvable, path);
});

test('the loader and the resolver agreed on every fixture path above that the file system can hold', () => {
  // Every path resolved through resolveBoth in this file was also loaded from the same tree on disk:
  // the plain tree, each link shape, the worked example, each fail-closed fixture but the submodule
  // and the empty link target (neither can be written to disk as such), and the 40 and 41 link chains.
  assert.ok(agreements >= 60, `${agreements} comparisons`);
});
