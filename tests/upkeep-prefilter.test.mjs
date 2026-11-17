// Knowledge upkeep, slice 2: classification with governing subtraction (design 6.1, 7.1 at the
// classification point) and the deterministic pre-filter (6.2). The first half runs the pure
// functions against in-memory trees; the second runs the job against real Git trees. Fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { upkeepProject, UPKEEP, FILES, write } from './upkeep-fixtures.mjs';
import { treeView } from '../starter/factory/core/tree-paths.mjs';
import { candidateFiles, classifyDocs, contextFiles, globDirectory, matchesGlob, mayHoldMatch, prefilterDecision, upgradeOwnedPath } from '../starter/factory/operations/upkeep-prefilter.mjs';
import { recordUpkeepSuspensionInTransaction } from '../starter/factory/operations/upkeep-records.mjs';
import { UPKEEP_FLAGS, UPKEEP_REASONS, upkeepOutcome } from '../starter/factory/operations/upkeep-runs.mjs';

// ---- In-memory trees: a string is a file, {link} a symbolic link, SUBMODULE a submodule ----
const link = target => ({ link: target }), SUBMODULE = { submodule: true };
const isLink = entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'link');
function memoryLookup(tree) {
  return (directories, name) => {
    let node = tree; for (const directory of directories) node = node[directory];
    if (!Object.hasOwn(node, name)) return null;
    const entry = node[name];
    return typeof entry === 'string' ? { type: 'file' } : isLink(entry) ? { type: 'link', target: entry.link } : entry === SUBMODULE ? { type: 'submodule' } : { type: 'directory' };
  };
}
const regularFiles = (tree, prefix = '') => Object.entries(tree).flatMap(([name, entry]) => typeof entry === 'string' ? [`${prefix}${name}`] : isLink(entry) || entry === SUBMODULE ? [] : regularFiles(entry, `${prefix}${name}/`));
const DOCS = { include: ['README.md', 'docs/**/*.md', '**/AGENTS.md'], exclude: ['docs/changes/**'], map: [] }, OWNED = { lock: 'factotum.lock.json', dirs: ['factory/'], files: [] };
const classify = (tree, context, { docs = DOCS, owned = OWNED, learningsDir = null } = {}) => { const view = treeView(memoryLookup(tree), context); return { ...classifyDocs({ files: regularFiles(tree), docs, view, owned, learningsDir }), contexts: contextFiles({ context, view, owned }).map(row => row.path) }; };
const context = (...paths) => ({ files: paths.map((path, index) => typeof path === 'string' ? { id: `entry-${index}`, path } : path), maxChars: 1000 });

test('globs: * and ? stay in a segment, ** crosses segments and **/ also matches no directory; the walk is kept to the folders a glob can reach', () => {
  for (const [glob, yes, no] of [
    ['README.md', ['README.md'], ['readme.md', 'docs/README.md', 'README.mdx']],
    ['docs/**/*.md', ['docs/a.md', 'docs/guide/a.md', 'docs/a/b/c.md'], ['docs/a.txt', 'README.md', 'xdocs/a.md', 'docs/a.md/x']],
    ['docs/*.md', ['docs/a.md'], ['docs/guide/a.md', 'docs/.md/x']],
    ['docs/api/**', ['docs/api/a.md', 'docs/api/v1/b.json'], ['docs/api', 'docs/apix/a.md']],
    ['**/AGENTS.md', ['AGENTS.md', 'a/AGENTS.md', 'a/b/AGENTS.md'], ['a/AGENTS.mdx', 'AGENTS.md/x']],
    ['src/?.js', ['src/a.js'], ['src/ab.js', 'src//.js']],
    ['a+b(1).md', ['a+b(1).md'], ['aab(1).md', 'a+b1.md']],
  ]) { for (const path of yes) assert.equal(matchesGlob(glob, path), true, `${glob} matches ${path}`); for (const path of no) assert.equal(matchesGlob(glob, path), false, `${glob} does not match ${path}`); }
  assert.deepEqual(['README.md', 'docs/**/*.md', 'docs/api/v1/*.md', '**/AGENTS.md', 'do*/x/a.md'].map(globDirectory), ['', 'docs/', 'docs/api/v1/', '', '']);
  const globs = ['docs/api/**', 'guides/*.md'];
  for (const [directory, reach] of [['docs/', true], ['docs/api/', true], ['docs/api/v1/', true], ['docs/other/', false], ['guides/', true], ['src/', false], ['doc/', false]]) assert.equal(mayHoldMatch(globs, directory), reach, directory);
  assert.equal(mayHoldMatch(['**/*.md'], 'anything/at/all/'), true);
});

test('classification: the docs set is the declared files less governing paths, upgrade-owned paths and the learnings directory, in that order', () => {
  const tree = { 'README.md': 'r', 'AGENTS.md': 'rules', 'factotum.lock.json': '{}', docs: { 'guide.md': 'g', 'notes.txt': 't', changes: { '2026.md': 'dated' }, learnings: { 'api.md': 'l' }, api: { 'AGENTS.md': 'api rules', 'index.md': 'i' } }, factory: { 'AGENTS.md': 'core' }, src: { 'main.js': 'c' } };
  // Declared and nothing else: the include globs less the exclude globs.
  assert.deepEqual(classify(tree, context()).docs, ['README.md', 'AGENTS.md', 'docs/guide.md', 'docs/learnings/api.md', 'docs/api/AGENTS.md', 'docs/api/index.md']);
  assert.deepEqual(classify(tree, context(), { docs: { ...DOCS, include: [] } }).docs, [], 'there is no default: a project that declares nothing has no docs set');
  // A file in both include and context.files is a context file and only a context file.
  const both = classify(tree, context('AGENTS.md', 'docs/api/AGENTS.md'));
  assert.deepEqual(both.docs, ['README.md', 'docs/guide.md', 'docs/learnings/api.md', 'docs/api/index.md']); assert.deepEqual(both.governing, ['AGENTS.md', 'docs/api/AGENTS.md']); assert.deepEqual(both.contexts, ['AGENTS.md', 'docs/api/AGENTS.md']);
  // The same file written another way in the entry, and in another letter case.
  for (const written of ['./README.md', 'docs/../README.md', 'docs/api/../../README.md', 'readme.md', 'README.MD']) assert.equal(classify(tree, context(written)).docs.includes('README.md'), false, written);
  // A case-only match protects the path, but the loader delivers nothing for it: it is no context candidate either.
  assert.deepEqual(classify(tree, context('readme.md')).contexts, []);
  // Upgrade-owned paths, compared without regard to case, with and without an install prefix.
  assert.equal(classify(tree, context()).docs.includes('factory/AGENTS.md'), false);
  assert.equal(classify({ ...tree, tools: { factotum: { factory: { 'AGENTS.md': 'core' }, 'VERSION.md': 'v' } } }, context(), { owned: { lock: 'factotum.lock.json', dirs: ['tools/factotum/factory/'], files: ['tools/factotum/VERSION.md'] }, docs: { ...DOCS, include: ['**/*.md'] } }).docs.some(path => path.startsWith('tools/factotum/')), false);
  for (const [path, owned] of [['factory/AGENTS.md', true], ['Factory/agents.md', true], ['FACTOTUM.LOCK.JSON', true], ['factoryx/a.md', false], ['docs/factory/a.md', false]]) assert.equal(upgradeOwnedPath(OWNED, path), owned, path);
  // An upgrade-owned context file is never a candidate.
  assert.deepEqual(classify(tree, context('factory/AGENTS.md', 'AGENTS.md')).contexts, ['AGENTS.md']);
  // The learnings directory.
  const learnt = classify(tree, context(), { learningsDir: 'docs/learnings' }); assert.equal(learnt.docs.includes('docs/learnings/api.md'), false); assert.equal(learnt.docs.includes('docs/guide.md'), true);
  assert.equal(classify({ ...tree, docs: { ...tree.docs, 'learnings.md': 'x' } }, context(), { learningsDir: 'docs/learnings' }).docs.includes('docs/learnings.md'), true, 'a file beside the directory is not in it');
  // The directory is resolved like a governing path: reached through a link, it is subtracted where it really is ...
  const throughLink = classify({ ...tree, notes: link('docs/learnings') }, context(), { learningsDir: 'notes' }); assert.equal(throughLink.docs.includes('docs/learnings/api.md'), false); assert.equal(throughLink.docs.includes('docs/guide.md'), true);
  assert.equal(classify(tree, context(), { learningsDir: 'docs/../docs/learnings/' }).docs.includes('docs/learnings/api.md'), false);
  // ... and one the tree cannot place leaves no docs set, which the run records.
  const lost = classify({ ...tree, notes: link('/var/learnings') }, context(), { learningsDir: 'notes' }); assert.deepEqual([lost.docs, lost.learningsUnresolvable, lost.governingUnresolvable], [[], true, false]);
  const undecided = prefilterDecision({ docCandidates: [], contextCandidates: [], governingUnresolvable: false, learningsUnresolvable: true, signals: [] });
  assert.deepEqual([undecided.outcome, undecided.reason, undecided.flags], ['abstained', 'learnings-unresolvable', ['learnings-unresolvable', 'no-signal']]); assert.ok(upkeepOutcome(undecided));
});

test('classification: a governing file reached through links is never a doc, whatever include or map says, in both directions', () => {
  const include = { ...DOCS, include: ['**/*.md'], map: [{ docs: 'docs/**', paths: ['src/**'] }] };
  const docsOf = (tree, entries) => classify(tree, context(...entries), { docs: include });
  // A link in a parent directory: rules/current is a link to ../docs, so the governing file is docs/AGENTS.md.
  const parent = { rules: { current: link('../docs') }, docs: { 'AGENTS.md': 'rules', 'guide.md': 'g' } };
  assert.deepEqual(docsOf(parent, ['rules/current/AGENTS.md']), { docs: ['docs/guide.md'], declared: 2, governing: ['docs/AGENTS.md'], governingUnresolvable: false, unresolvable: [], contexts: ['docs/AGENTS.md'] });
  // A link in a grandparent directory, a file that is itself a link, a chain of two and of three links.
  assert.deepEqual(docsOf({ a: link('real'), real: { b: { 'RULES.md': 'r', 'other.md': 'o' } } }, ['a/b/RULES.md']).docs, ['real/b/other.md']);
  assert.deepEqual(docsOf({ 'CURRENT.md': link('docs/rules.md'), docs: { 'rules.md': 'r', 'a.md': 'a' } }, ['CURRENT.md']).docs, ['docs/a.md']);
  assert.deepEqual(docsOf({ one: link('two'), two: link('three'), three: link('docs'), docs: { 'rules.md': 'r', 'a.md': 'a' } }, ['one/rules.md']).docs, ['docs/a.md']);
  // A target whose `..` follows a link (the worked example of 7.1): the governing file is private/AGENTS.md,
  // and docs/AGENTS.md is not treated as the governing file on that account.
  const worked = { rules: link('docs/jump/..'), docs: { jump: link('../private/subdir'), 'AGENTS.md': 'an ordinary doc' }, private: { subdir: {}, 'AGENTS.md': 'the rules' } };
  assert.deepEqual(docsOf(worked, ['rules/AGENTS.md']), { docs: ['docs/AGENTS.md'], declared: 2, governing: ['private/AGENTS.md'], governingUnresolvable: false, unresolvable: [], contexts: ['private/AGENTS.md'] });
  // A governing entry that does not exist still protects its path; it is no context candidate.
  assert.deepEqual(docsOf({ docs: { 'a.md': 'a' } }, ['docs/planned.md']), { docs: ['docs/a.md'], declared: 1, governing: [], governingUnresolvable: false, unresolvable: [], contexts: [] });
});

test('classification: when a governing entry cannot be resolved there is no docs set and no context candidate (fail closed)', () => {
  const docs = { 'a.md': 'a', 'AGENTS.md': 'rules' };
  for (const [name, tree, entry] of [
    ['an escape hidden by early cancellation', { rules: link('sub/hop/../x'), sub: { hop: link('../..'), x: { 'AGENTS.md': 'r' } }, docs }, 'rules/AGENTS.md'],
    ['a cycle', { loop: link('loop'), docs }, 'loop/AGENTS.md'],
    ['an absolute target', { rules: link('/etc'), docs }, 'rules/AGENTS.md'],
    ['a target that leaves the repository', { rules: link('../outside'), docs }, 'rules/AGENTS.md'],
    ['a submodule on the path', { vendor: SUBMODULE, docs }, 'vendor/AGENTS.md'],
  ]) {
    const result = classify(tree, context(entry, 'docs/AGENTS.md'), { docs: { ...DOCS, include: ['**/*.md'] } });
    assert.deepEqual(result.docs, [], name); assert.equal(result.governingUnresolvable, true, name); assert.equal(result.unresolvable.length, 1, name); assert.deepEqual(result.contexts, [], name);
    assert.ok(result.declared >= 2, 'the declared files exist; none can be shown to be outside the protected set');
  }
});

test('the pre-filter: a file is a candidate when it names a touched path or is mapped to one; an edited file only through a removed path', () => {
  const texts = { 'README.md': 'Start with src/api/users.js.', 'docs/guide.md': 'No source file is named here.', 'docs/api/overview.md': 'The API.', 'docs/old.md': 'See src/legacy.js and src/api/users.js.', 'AGENTS.md': 'Never import src/legacy.js.', 'rules/api.md': 'API rules.' };
  const docs = ['README.md', 'docs/guide.md', 'docs/api/overview.md', 'docs/old.md'], contexts = [{ id: 'rules', path: 'AGENTS.md', paths: [] }, { id: 'api', path: 'rules/api.md', paths: ['src/api/*'] }];
  const find = (touched, map = []) => candidateFiles({ docs, contexts, map, touched, text: path => texts[path] });
  const modified = path => ({ path, change: 'modified' }), deleted = path => ({ path, change: 'deleted' }), added = path => ({ path, change: 'added' });
  // A reference to a touched path, in a doc and in a governing file.
  assert.deepEqual(find([modified('src/api/users.js')]), { docCandidates: ['README.md', 'docs/old.md'], contextCandidates: ['rules/api.md'] });
  assert.deepEqual(find([deleted('src/legacy.js')]), { docCandidates: ['docs/old.md'], contextCandidates: ['AGENTS.md'] });
  // Nothing refers to it and nothing is mapped to it.
  assert.deepEqual(find([modified('src/internal/cache.js'), added('src/internal/new.js')]), { docCandidates: [], contextCandidates: [] });
  // A doc mapped to a touched path, and a context entry selected by its own paths, as the loader matches them.
  assert.deepEqual(find([added('src/api/v2/routes.js')], [{ docs: 'docs/api/**', paths: ['src/api/**'] }]), { docCandidates: ['docs/api/overview.md'], contextCandidates: ['rules/api.md'] });
  assert.deepEqual(find([modified('src/apix/a.js')], [{ docs: 'docs/api/**', paths: ['src/api/**'] }]), { docCandidates: [], contextCandidates: [] });
  // A file the merge itself edited: not through a path it changed, and not through a map ...
  assert.deepEqual(find([modified('README.md'), modified('src/api/users.js'), modified('docs/api/overview.md'), modified('rules/api.md')], [{ docs: 'docs/api/**', paths: ['src/api/**'] }]), { docCandidates: ['docs/old.md'], contextCandidates: [] });
  // ... only through a reference to a path the merge removed. A rename is a removal and an addition.
  assert.deepEqual(find([modified('docs/old.md'), deleted('src/legacy.js'), added('src/modern.js'), modified('AGENTS.md')]), { docCandidates: ['docs/old.md'], contextCandidates: ['AGENTS.md'] });
  // A file that was not read (too large, or not text) is no candidate by reference.
  assert.deepEqual(candidateFiles({ docs: ['big.md'], contexts: [], map: [], touched: [modified('src/a.js')], text: () => undefined }), { docCandidates: [], contextCandidates: [] });
});

test('several governing entries that reach one file: it is listed once with the union of their mappings, whatever their order', () => {
  const tree = { 'RULES.md': 'Rules that name no source file.', rules: link('.'), src: { one: { 'file.js': 'a' }, two: { 'file.js': 'b' } } };
  const one = { id: 'one', path: 'RULES.md', paths: ['src/one/*'] }, two = { id: 'two', path: 'RULES.md', paths: ['src/two/*'] };
  const filesOf = entries => contextFiles({ context: context(...entries), view: treeView(memoryLookup(tree), context(...entries)), owned: OWNED });
  const candidates = (entries, changed) => candidateFiles({ docs: [], contexts: filesOf(entries), map: [], touched: [{ path: changed, change: 'modified' }], text: () => 'Rules that name no source file.' }).contextCandidates;
  for (const entries of [[one, two], [two, one]]) {
    assert.deepEqual(filesOf(entries).map(row => [row.path, [...row.ids].sort(), [...row.paths].sort()]), [['RULES.md', ['one', 'two'], ['src/one/*', 'src/two/*']]]);
    assert.deepEqual(candidates(entries, 'src/two/file.js'), ['RULES.md'], `the second mapping selects it (${entries.map(row => row.id)})`);
    assert.deepEqual(candidates(entries, 'src/one/file.js'), ['RULES.md']); assert.deepEqual(candidates(entries, 'src/three/file.js'), []);
  }
  // The same file reached a second time through a link, and an entry with no mapping beside one that has.
  const linked = { id: 'linked', path: 'rules/RULES.md', paths: ['src/two/*'] }, always = { id: 'always', path: './RULES.md' };
  for (const entries of [[one, linked], [linked, one], [always, two], [two, always]]) { assert.equal(filesOf(entries).length, 1); assert.deepEqual(candidates(entries, 'src/two/file.js'), ['RULES.md'], entries.map(row => row.id).join()); }
  assert.deepEqual(filesOf([always, two])[0].paths, ['src/two/*']); assert.deepEqual(candidates([always, one], 'src/two/file.js'), []);
  // A repeated pattern is kept once.
  assert.deepEqual(filesOf([one, { ...one, id: 'again' }])[0].paths, ['src/one/*']);
});

test('the pre-filter decision: every reason of 6.2 that this release can reach, and what would have been assessed', () => {
  const verified = { class: 'verified' }, weak = { class: 'weak' }, base = { docCandidates: [], contextCandidates: [], governingUnresolvable: false, signals: [], maxWaiting: 10 };
  const decide = extra => { const { counts, stage, ...rest } = prefilterDecision({ ...base, ...extra }); assert.equal(stage, 'pre-filter'); return rest; };
  // No candidate file and no signal at all.
  assert.deepEqual(decide({}), { outcome: 'nothing', reason: 'no-referring-doc', flags: ['no-signal'], assess: null });
  // No candidate file, and the only signals are weak ones: they never count alone (N5).
  assert.deepEqual(decide({ signals: [weak, weak] }), { outcome: 'nothing', reason: 'weak-signals-only', flags: [], assess: null });
  // A candidate file, or a verified correction, would reach the model. This release has none to call.
  assert.deepEqual(decide({ docCandidates: ['README.md'] }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: [], assess: { docs: true, context: false, capture: false } });
  assert.deepEqual(decide({ contextCandidates: ['AGENTS.md'], signals: [weak] }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: [], assess: { docs: false, context: true, capture: false } });
  assert.deepEqual(decide({ signals: [verified, weak] }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: [], assess: { docs: false, context: false, capture: true } });
  // The part that would act is suspended.
  const suspended = (...parts) => part => parts.includes(part);
  assert.deepEqual(decide({ docCandidates: ['README.md'], suspended: suspended('docs') }), { outcome: 'abstained', reason: 'suspended', flags: ['docs-suspended'], assess: null });
  assert.deepEqual(decide({ docCandidates: ['README.md'], contextCandidates: ['AGENTS.md'], suspended: suspended('docs') }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: ['docs-suspended'], assess: { docs: false, context: true, capture: false } });
  assert.deepEqual(decide({ docCandidates: ['README.md'], signals: [verified], suspended: suspended('model') }), { outcome: 'abstained', reason: 'suspended', flags: ['model-suspended'], assess: null });
  assert.deepEqual(decide({ docCandidates: ['README.md'], suspended: suspended('all') }), { outcome: 'abstained', reason: 'suspended', flags: [], assess: null });
  // The docs backlog is full and there is nothing else to assess.
  assert.deepEqual(decide({ docCandidates: ['README.md'], docsWaiting: 10 }), { outcome: 'abstained', reason: 'backlog-full', flags: ['backlog-full'], assess: null });
  assert.deepEqual(decide({ docCandidates: ['README.md'], docsWaiting: 10, signals: [verified] }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: ['backlog-full'], assess: { docs: false, context: false, capture: true } });
  assert.deepEqual(decide({ docCandidates: ['README.md'], docsWaiting: 9 }).reason, 'assessment-unavailable');
  // A governing entry cannot be resolved, and there is nothing but docs to assess.
  assert.deepEqual(decide({ governingUnresolvable: true }), { outcome: 'abstained', reason: 'governing-unresolvable', flags: ['governing-unresolvable', 'no-signal'], assess: null });
  assert.deepEqual(decide({ governingUnresolvable: true, signals: [weak] }), { outcome: 'abstained', reason: 'governing-unresolvable', flags: ['governing-unresolvable'], assess: null });
  assert.deepEqual(decide({ governingUnresolvable: true, signals: [verified] }), { outcome: 'abstained', reason: 'assessment-unavailable', flags: ['governing-unresolvable'], assess: { docs: false, context: false, capture: true } });
  // A project that declared no docs says so.
  assert.deepEqual(decide({ docsDeclared: false }).flags, ['docs-not-declared', 'no-signal']);
  // Every decision records an outcome a run accepts.
  for (const extra of [{}, { signals: [weak] }, { docCandidates: ['a'] }, { governingUnresolvable: true }, { docCandidates: ['a'], docsWaiting: 10 }, { docCandidates: ['a'], suspended: suspended('docs') }]) { const decision = prefilterDecision({ ...base, ...extra }), recorded = upkeepOutcome(decision); assert.ok(recorded, JSON.stringify(decision)); assert.ok(UPKEEP_REASONS.includes(recorded.reason)); assert.deepEqual(recorded.flags.sort(), [...decision.flags].sort()); for (const flag of decision.flags) assert.ok(UPKEEP_FLAGS.includes(flag), flag); }
});

// ---- The job against real Git trees ----
// What the pre-filter counted, apart from what the model stage adds (tests/upkeep-assessment.test.mjs).
const PRE = ['touchedPaths', 'docsFiles', 'docCandidates', 'contextCandidates', 'verifiedSignals', 'weakSignals', 'filesRead'], pre = counts => Object.fromEntries(PRE.filter(name => name in counts).map(name => [name, counts[name]]));
const outcomeOf = run => ({ outcome: run.outcome, reason: run.reason, flags: run.flags });
const NOTE = { step: 'post', answer: 'note', note: 'Fictional operator note', actor: 'operator', at: '2026-11-16T10:00:00.000Z' };
const CORRECTION = [{ attemptId: 'review-1', step: 'review', phase: 'full', disposition: 'correct', result: { verdict: 'revise', findings: [{ message: 'Fictional missing null check', severity: 'medium' }] } }, { attemptId: 'review-2', step: 'review', phase: 'full', disposition: 'accepted', result: { verdict: 'pass', findings: [], priorFindingsDisposition: [{ finding: 'Fictional missing null check', disposition: 'fixed', evidence: 'Guarded at src/parse.js:12' }] } }];

test('the job: referring docs, maps, governing files and signals at the merge commit decide whether the model is asked', async t => {
  const f = upkeepProject(t, { upkeep: { ...UPKEEP, docs: { ...UPKEEP.docs, map: [{ docs: 'docs/api/**', paths: ['src/api/**'] }] } }, context: { files: [{ id: 'rules', path: 'AGENTS.md', required: true }, { id: 'server', path: 'docs/guide.md', paths: ['src/server*'] }], maxChars: 4000 } });
  const assessed = async (name, edit, options) => { await f.mergedAndFinished(name, edit, options); return (await f.assess()).run; };
  // README.md names the changed file and docs/api/overview.md is mapped to it; the dated record that names it is excluded.
  let run = await assessed('reference', root => write(root, { 'src/api/users.js': 'export const users = [1];\n' }));
  assert.deepEqual(outcomeOf(run), { outcome: 'nothing', reason: 'no-candidate', flags: [] });
  assert.deepEqual(pre(run.counts), { touchedPaths: 1, docsFiles: 2, docCandidates: 2, contextCandidates: 0, verifiedSignals: 0, weakSignals: 0, filesRead: 4 }, 'docs/guide.md is governing here, so the docs set is README.md and docs/api/overview.md');
  // A deleted file a governing file names: a context candidate, never a docs candidate.
  run = await assessed('deleted', root => rmSync(join(root, 'src/legacy.js')));
  assert.deepEqual(pre(run.counts), { touchedPaths: 1, docsFiles: 2, docCandidates: 0, contextCandidates: 1, verifiedSignals: 0, weakSignals: 0, filesRead: 4 }); assert.equal(run.reason, 'no-candidate'); assert.equal(run.stage, 'model');
  // A context entry selected by its own paths.
  run = await assessed('own-paths', root => write(root, { 'src/server.js': 'import "./api/users.js"; // changed\n' }));
  assert.equal(run.counts.contextCandidates, 1); assert.equal(run.counts.docCandidates, 1, 'README.md names src/server.js too');
  // Nothing refers to it: no model would run. With only an operator note, the same, said differently.
  run = await assessed('quiet', root => write(root, { 'src/internal.js': 'export {};\n' }));
  assert.deepEqual(outcomeOf(run), { outcome: 'nothing', reason: 'no-referring-doc', flags: ['no-signal'] });
  run = await assessed('weak', root => write(root, { 'src/internal.js': 'export const a = 1;\n' }), { patch: flow => { flow.operatorFeedback = [NOTE]; } });
  assert.deepEqual(outcomeOf(run), { outcome: 'nothing', reason: 'weak-signals-only', flags: [] }); assert.equal(run.counts.weakSignals, 1);
  // A verified correction would be assessed even though no file refers to the change.
  run = await assessed('verified', root => write(root, { 'src/internal.js': 'export const a = 2;\n' }), { patch: flow => { flow.reviewHistory = CORRECTION; } });
  assert.deepEqual(outcomeOf(run), { outcome: 'nothing', reason: 'no-candidate', flags: [] }); assert.deepEqual([run.counts.verifiedSignals, run.counts.docCandidates, run.counts.contextCandidates], [1, 0, 0]);
  // A doc the merge itself edited: only through a path the merge removed.
  run = await assessed('edited', root => write(root, { 'README.md': `${FILES['README.md']}Edited by the change itself.\n`, 'src/api/users.js': 'export const users = [2];\n' }));
  assert.equal(run.counts.docCandidates, 1, 'README.md is not a candidate; the mapped overview still is');
  run = await assessed('edited-and-removed', root => { write(root, { 'README.md': `${FILES['README.md']}Edited again.\n` }); rmSync(join(root, 'src/api/users.js')); });
  assert.equal(run.counts.docCandidates, 2, 'README.md still names the removed src/api/users.js');
  // Suspended parts and a full backlog are read from the store.
  f.store.setMeta('upkeepOpen', { docsTask: null, candidates: { docs: 10 } });
  run = await assessed('backlog', root => write(root, { 'src/server.js': 'import "./api/users.js"; // again\n' }), { patch: flow => { flow.reviewHistory = CORRECTION; } });
  assert.deepEqual(run.flags, ['backlog-full']); assert.equal(run.reason, 'no-candidate'); assert.equal(run.stage, 'model');
  f.store.setMeta('upkeepOpen', { docsTask: null, candidates: {} });
  f.store.tx(() => recordUpkeepSuspensionInTransaction(f.store, { part: 'context', rule: 'fictional', reason: 'Fictional suspension of the context part' }));
  run = await assessed('suspended', root => write(root, { 'src/legacy2.js': 'export {};\n', 'AGENTS.md': FILES['AGENTS.md'] }));
  assert.equal(run.reason, 'no-referring-doc');
  run = await assessed('suspended-context', root => write(root, { 'src/server.js': 'import "./api/users.js"; // third\n' }));
  assert.deepEqual(run.flags, ['context-suspended']); assert.equal(run.reason, 'no-candidate', 'README.md still names it');
  assert.equal(f.store.count('finding'), 0);
});

test('the job: a governing file reached through a linked parent directory is a context file and never a doc; an unresolvable entry leaves no docs set', async t => {
  // rules/current is a link to ../docs, so the governing entry rules/current/AGENTS.md is docs/AGENTS.md, inside the docs globs.
  const linked = upkeepProject(t, { files: { ...FILES, 'docs/AGENTS.md': 'Rules: never import src/legacy.js.\n' }, setup: root => { write(root, { 'rules/.keep': '' }); rmSync(join(root, 'rules/.keep')); symlinkSync('../docs', join(root, 'rules/current')); }, context: { files: [{ id: 'rules', path: 'rules/current/AGENTS.md', required: true }], maxChars: 4000 } });
  assert.equal(execFileSync('git', ['ls-files', '-s', 'rules/current'], { cwd: linked.root, encoding: 'utf8' }).slice(0, 6), '120000', 'the link is in the tree');
  await linked.mergedAndFinished('a', root => rmSync(join(root, 'src/legacy.js')));
  let run = (await linked.assess()).run;
  assert.deepEqual(pre(run.counts), { touchedPaths: 1, docsFiles: 3, docCandidates: 0, contextCandidates: 1, verifiedSignals: 0, weakSignals: 0, filesRead: 4 }, 'docs/AGENTS.md names the removed file, as a governing file only');
  // The same repository with the governing entry written as the real path gives the same answer.
  const direct = upkeepProject(t, { files: { ...FILES, 'docs/AGENTS.md': 'Rules: never import src/legacy.js.\n' }, context: { files: [{ id: 'rules', path: 'docs/AGENTS.md', required: true }], maxChars: 4000 } });
  await direct.mergedAndFinished('a', root => rmSync(join(root, 'src/legacy.js'))); assert.deepEqual(pre((await direct.assess()).run.counts), pre(run.counts));
  // Without the governing entry the same file is a doc: the subtraction is what removed it.
  const plain = upkeepProject(t, { files: { ...FILES, 'docs/AGENTS.md': 'Rules: never import src/legacy.js.\n' } });
  await plain.mergedAndFinished('a', root => rmSync(join(root, 'src/legacy.js'))); run = (await plain.assess()).run;
  assert.deepEqual([run.counts.docsFiles, run.counts.docCandidates, run.counts.contextCandidates], [4, 1, 1]);
  // A governing entry the merge commit's tree cannot place (an absolute link target): no docs candidates, and the run says so.
  const broken = upkeepProject(t, { context: { files: [{ id: 'rules', path: 'AGENTS.md', required: true }, { id: 'outside', path: 'vendor/rules.md' }], maxChars: 4000 } });
  await broken.mergedAndFinished('a', root => { symlinkSync('/etc', join(root, 'vendor')); write(root, { 'src/api/users.js': 'export const users = [3];\n' }); });
  run = (await broken.assess()).run;
  assert.deepEqual(outcomeOf(run), { outcome: 'abstained', reason: 'governing-unresolvable', flags: ['no-signal', 'governing-unresolvable'] }); assert.deepEqual([run.counts.docsFiles, run.counts.docCandidates, run.counts.contextCandidates], [0, 0, 0]);
  // With a verified correction the run goes on for the capture part only, and still records it.
  await broken.mergedAndFinished('b', root => write(root, { 'src/api/users.js': 'export const users = [4];\n' }), { patch: flow => { flow.reviewHistory = CORRECTION; } });
  run = (await broken.assess()).run; assert.deepEqual(outcomeOf(run), { outcome: 'nothing', reason: 'no-candidate', flags: ['governing-unresolvable'] }); assert.equal(run.counts.docCandidates, 0);
});

test('the job: two governing entries map one file to different paths, and a change under either selects it, in either order', async t => {
  const entries = [{ id: 'one', path: 'RULES.md', paths: ['src/one/*'] }, { id: 'two', path: 'RULES.md', paths: ['src/two/*'] }];
  for (const files of [entries, [...entries].reverse()]) {
    const f = upkeepProject(t, { files: { ...FILES, 'RULES.md': 'Rules that name no source file.\n', 'src/one/file.js': 'export {};\n', 'src/two/file.js': 'export {};\n' }, context: { files: [{ id: 'rules', path: 'AGENTS.md', required: true }, ...files], maxChars: 4000 } });
    await f.mergedAndFinished('a', root => write(root, { 'src/two/file.js': 'export const two = 2;\n' }));
    const run = (await f.assess()).run;
    assert.deepEqual([run.reason, run.counts.contextCandidates, run.counts.docCandidates], ['no-candidate', 1, 0], files.map(row => row.id).join());
  }
});

test('the job reads Git through verified objects: one fetch when the merge commit is not held yet, none when it is, and nothing when it cannot be had', async t => {
  const f = upkeepProject(t), fetches = [], run = async (command, args, options) => { if (args.includes('fetch')) fetches.push(args.filter(arg => !arg.startsWith('-')).join(' ')); const { runProcess } = await import('../starter/factory/adapters/providers/index.mjs'); return runProcess(command, args, options); };
  const merged = await f.mergedAndFinished('a');
  assert.throws(() => execFileSync('git', ['cat-file', '-e', merged.sha], { cwd: f.root, stdio: 'pipe' }), 'the project checkout does not hold the merge commit yet');
  const first = await f.assess({ run }); assert.equal(first.run.reason, 'no-candidate'); assert.equal(first.outcome.upkeepRun.mergeCommit, merged.sha); assert.equal(first.outcome.upkeepRun.base, merged.base);
  assert.equal(fetches.length, 1); assert.match(fetches[0], /fetch .*origin main$/);
  // Held now: a run by hand reads it without a fetch.
  assert.equal(f.command('job.enqueue', { operation: 'knowledge.upkeep', payload: { flowId: merged.flowId }, note: 'Again' }).status, 'completed');
  await f.assess({ run }); assert.equal(fetches.length, 1, 'no second fetch');
  // A merge commit the remote does not have: the run abstains, it does not guess.
  const lost = await f.merge('b'); const receipt = f.run(lost.flowId); f.store.put('upkeepRun', { ...receipt, mergeCommit: 'f'.repeat(40) }); await f.finish(lost.flowId);
  const missing = await f.assess({ run }); assert.deepEqual(outcomeOf(missing.run), { outcome: 'abstained', reason: 'merge-commit-unavailable', flags: [] }); assert.equal(fetches.length, 2);
  // A repository with replacement refs is refused outright, as every check that reads verified objects
  // refuses it: the assessment fails, and in service its run closes as an error. It is never read around.
  const other = await f.mergedAndFinished('c', root => write(root, { 'src/internal.js': 'export {};\n' }));
  execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: f.root }); execFileSync('git', ['replace', other.sha, merged.sha], { cwd: f.root });
  await assert.rejects(f.assess({ run }), /replacement refs/);
});
