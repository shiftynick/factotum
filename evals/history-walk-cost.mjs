// Measure (not part of npm run eval) the cost of the verified history reads on a long history:
// a prefixed adoption of the real starter, updated across 6 releases, with ordinary commits in
// between (written with git fast-import, 40 files at the root).
//
// Usage (run from the reference checkout):
//   node evals/history-walk-cost.mjs [commits=3000]
//   Ancestry refusals (the target is not in the history, so everything is walked) on hostile shapes:
//   node evals/history-walk-cost.mjs --linear <n>       n commits in a line
//   node evals/history-walk-cost.mjs --absent <n>       a line of n commits with a merge 70 commits below
//                                                    the tip whose second parent is future-dated and
//                                                    has an absent parent
//   node evals/history-walk-cost.mjs --quadratic <n> [chain=20000]  one future-dated chain from the
//                                                    base, and n past-dated merges on the main line,
//                                                    each with the chain's tip as second parent
//   node evals/history-walk-cost.mjs --merges <n> [chain=25]  n merges whose second parents are
//                                                    future-dated chains of that length
//   node evals/history-walk-cost.mjs --shallow <depth>   a real shallow clone of one line
//   node evals/history-walk-cost.mjs --shallow-two <depth>  a real shallow clone of two lines
//                                                    merged at the tip (two boundary commits), one
//                                                    line older than the other
//   node evals/history-walk-cost.mjs --shallow-all <n>   a line of n commits and a shallow file (as a
//                                                    builder could write one) naming every commit
//   node evals/history-walk-cost.mjs --garbage <n>       --absent, with a garbage loose object stored
//                                                    under the absent parent's ID
//   node evals/history-walk-cost.mjs --absent-near <n>   a line of n commits under a merge, 63 commits
//                                                    below the tip, whose second parent is absent
//   node evals/history-walk-cost.mjs --behind <n>        ownChanges of a factory merge whose target is n
//                                                    commits ahead of the candidate's fork point
//   node evals/history-walk-cost.mjs --behind-absent <n> --behind, with a future-dated side commit whose
//                                                    parent is absent merged into the target 70 commits
//                                                    below its tip
//   node evals/history-walk-cost.mjs --shared-garbage <n>  a line of n commits where one unreadable
//                                                    object is the second parent of a merge 70 commits
//                                                    below the tip and of a commit 3 below it
//   node evals/history-walk-cost.mjs --absent-own <n>    ownChanges (trusted: the start) of --absent
//   node evals/history-walk-cost.mjs --gaps <n> [count=100]  a line of n commits with count merges,
//                                                    each with its own unreadable second parent
//   (ownChanges modes report the number of offending rows as "found".)
//   Add --old-git to the shape modes to walk as with a Git older than 2.44 (no --missing=print
//   for commits). Shape modes report the Git processes the walk started.
//
// Reports, each in a fresh Node process so nothing is cached: a cold `adoptionStatus` (which
// includes the history walk) with its peak resident memory, and the bounded ancestry check that
// `workspace.commit` makes when the recorded target is not in HEAD (the worst case: every commit is
// walked before refusing; a legitimate merge has the target as a direct parent), against a
// plain `git log` of the lock for scale.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const repo = process.cwd(), base = mkdtempSync(join(tmpdir(), 'factotum-history-cost-'));
const { buildRelease, prepareAdoption } = await import(join(repo, 'starter/factory/distribution.mjs'));
const git = (cwd, args, input) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, input, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
// Time VerifiedObjects.reaches in a fresh process, counting the Git processes it starts (a git on
// PATH that counts, then runs the real one).
const args = process.argv.slice(2).filter(arg => arg !== '--old-git'), oldGit = process.argv.includes('--old-git');
const timeReaches = (root, head, target, call = `objects.reaches(${JSON.stringify(head)}, ${JSON.stringify(target)})`) => {
  const bin = join(base, 'bin'), log = join(bin, 'count'), real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, 'git'), `#!/bin/sh\necho >> "$FACTOTUM_EVAL_GIT_COUNT"\nexec ${real} "$@"\n`, { mode: 0o755 }); writeFileSync(log, '');
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const { VerifiedObjects } = await import(${JSON.stringify(join(repo, 'starter/factory/core/verified-git.mjs'))});
  const objects = new VerifiedObjects(${JSON.stringify(root)}); ${oldGit ? 'objects.missingPrint = false;' : ''}
  const t = process.hrtime.bigint(); let result, error; try { result = ${call}; } catch (caught) { error = caught.message.slice(0, 120); }
  const found = error ? { error } : Array.isArray(result) ? result.length : result;
  console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - t) / 1e6, found, maxRssMb: process.resourceUsage().maxRSS / 1024 }));`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FACTOTUM_EVAL_GIT_COUNT: log } }));
  return { ...result, gitProcesses: readFileSync(log, 'utf8').length };
};
const mode = args[0];
if (['--merges', '--shallow', '--shallow-two', '--linear', '--absent', '--quadratic', '--shallow-all', '--garbage', '--absent-near', '--behind', '--behind-absent', '--shared-garbage', '--absent-own', '--gaps'].includes(mode)) {
  try {
    const root = join(base, 'app'); mkdirSync(root); git(root, ['init', '-qb', 'main']); git(root, ['config', 'user.email', 'm@example.invalid']); git(root, ['config', 'user.name', 'M']);
    writeFileSync(join(root, 'a.txt'), 'a\n'); git(root, ['add', '.']); execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Base'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '1000000000 +0000', GIT_COMMITTER_DATE: '1000000000 +0000' } });
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']), unrelated = git(root, ['commit-tree', tree, '-m', 'Unrelated target']), n = Number(args[1]), chain = Number(args[2] ?? (mode === '--quadratic' ? 20000 : 25));
    let stream = '', mark = 0; const now = Math.floor(Date.now() / 1000), future = now + 10 * 365 * 86400, start = git(root, ['rev-parse', 'HEAD']);
    const commitAt = (ref, date, parents, message) => { mark++; stream += `commit ${ref}\nmark :${mark}\ncommitter M <m@example.invalid> ${date} +0000\ndata ${message.length}\n${message}\n${parents.map((p, i) => `${i ? 'merge' : 'from'} ${p}\n`).join('')}\n`; return `:${mark}`; };
    // A commit object whose parent does not exist (fast-import refuses to write one).
    const absentParent = date => git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${'1'.repeat(40)}\nauthor M <m@example.invalid> ${date} +0000\ncommitter M <m@example.invalid> ${date} +0000\n\nabsent parent\n`);
    if (mode === '--merges') {
      let main = start;
      for (let i = 0; i < n; i++) {
        let tip = main; for (let j = 0; j < chain; j++) tip = commitAt('refs/heads/chain', future + i * 100 + j, [tip], `chain ${i} ${j}`);
        main = commitAt('refs/heads/main', now - n + i, [main, tip], `merge ${i}`);
      }
    } else if (['--behind', '--behind-absent'].includes(mode)) { let tip = start; for (let i = 0; i < n; i++) tip = commitAt('refs/heads/main', now - n + i, mode === '--behind-absent' && i === n - 70 ? [tip, absentParent(future)] : [tip], `c ${i}`); }
    else if (['--linear', '--shallow-all', '--absent-near'].includes(mode)) { let tip = start; for (let i = 0; i < n; i++) tip = commitAt('refs/heads/main', now - n + i, [tip], `c ${i}`); }
    else if (['--absent', '--garbage', '--absent-own'].includes(mode)) { let tip = start; for (let i = 0; i < n; i++) tip = commitAt('refs/heads/main', now - n + i, i === n - 70 ? [tip, absentParent(future)] : [tip], `c ${i}`); }
    else if (mode === '--quadratic') { let tip = start, chainTip = start; for (let j = 0; j < chain; j++) chainTip = commitAt('refs/heads/chain', future + j, [chainTip], `chain ${j}`); for (let i = 0; i < n; i++) tip = commitAt('refs/heads/main', now - n + i, [tip, chainTip], `merge ${i}`); }
    else if (['--shared-garbage', '--gaps'].includes(mode)) { /* built below in segments */ commitAt('refs/heads/main', now - n, [start], 'segment start'); }
    else if (mode === '--shallow') { let tip = start; for (let i = 0; i < n + 100; i++) tip = commitAt('refs/heads/main', now - n - 100 + i, [tip], `c ${i}`); }
    // Line b is older than all of line a, so a date-ordered listing reaches line a's boundary first.
    else { let a = start, b = start; for (let i = 0; i < n + 100; i++) { a = commitAt('refs/heads/line-a', now - n - 100 + i, [a], `a ${i}`); b = commitAt('refs/heads/line-b', now - 3 * n - 300 + i, [b], `b ${i}`); } commitAt('refs/heads/main', now, [a, b], 'join'); }
    git(root, ['fast-import', '--quiet', '--force'], stream); git(root, ['reset', '-q', '--hard', 'main']);
    if (mode === '--absent-near') {
      // A merge whose second parent is absent, 63 commits below the tip: that ID is in the frontier when proposing starts.
      const near = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${git(root, ['rev-parse', 'main'])}\nparent ${'3'.repeat(40)}\nauthor M <m@example.invalid> ${now} +0000\ncommitter M <m@example.invalid> ${now} +0000\n\nnear\n`);
      let more = ''; for (let i = 0; i < 63; i++) more += `commit refs/heads/main\ncommitter M <m@example.invalid> ${now + i} +0000\ndata 4\nnear\n${i ? '' : `from ${near}\n`}\n`;
      git(root, ['fast-import', '--quiet', '--force'], more); git(root, ['reset', '-q', '--hard', 'main']);
    }
    // Segments of the main line joined by merges whose second parent is a garbage object (written below).
    const garbageIds = [], extend = (from, count, at) => { let more = ''; for (let i = 0; i < count; i++) more += `commit refs/heads/main\ncommitter M <m@example.invalid> ${at + i} +0000\ndata 4\nline\n${i ? '' : `from ${from}\n`}\n`; if (count) { git(root, ['fast-import', '--quiet', '--force'], more); } return git(root, ['rev-parse', 'main']); };
    const mergeWith = (first, second, at) => git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${first}\nparent ${second}\nauthor M <m@example.invalid> ${at} +0000\ncommitter M <m@example.invalid> ${at} +0000\n\ngap\n`);
    if (mode === '--shared-garbage') {
      // One unreadable object named as a parent twice: by a merge 70 commits below the tip and by a commit 3 below it.
      const shared = '1'.repeat(40); garbageIds.push(shared);
      let tip = extend(git(root, ['rev-parse', 'main']), n - 70, now - n);
      tip = extend(mergeWith(tip, shared, now - 71), 66, now - 70); tip = extend(mergeWith(tip, shared, now - 4), 3, now - 3);
      git(root, ['update-ref', 'refs/heads/main', tip]); git(root, ['reset', '-q', '--hard', 'main']);
    }
    if (mode === '--gaps') {
      // count merges, evenly spaced, each with its own unreadable second parent.
      const count = Number(args[2] ?? 100), step = Math.floor(n / (count + 1)); let tip = git(root, ['rev-parse', 'main']);
      for (let i = 0; i < count; i++) { const gap = (i + 1).toString(16).padStart(40, 'a'); garbageIds.push(gap); tip = extend(mergeWith(tip, gap, now - n + i * step), step, now - n + i * step + 1); }
      tip = extend(tip, n - count * step - count, now - 1); git(root, ['update-ref', 'refs/heads/main', tip]); git(root, ['reset', '-q', '--hard', 'main']);
    }
    // B3: a candidate one commit from the start merged with a target n commits ahead, as the factory's integration makes it.
    let behind = null;
    if (['--behind', '--behind-absent'].includes(mode)) {
      // Dated in order (the base is older than the target's commits, the merge newer), as in an honest repository.
      const target = git(root, ['rev-parse', 'main']), at = date => `author M <m@example.invalid> ${date} +0000\ncommitter M <m@example.invalid> ${date} +0000\n`;
      const candidate = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${start}\n${at(now + 1)}\nCandidate\n`);
      behind = { target, head: git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nparent ${candidate}\nparent ${target}\n${at(now + 2)}\nFactory merge\n`) };
    }
    const listedCommits = git(root, ['rev-list', '--missing=print', behind?.head ?? 'HEAD']).split('\n').filter(line => line && line[0] !== '?');
    for (const id of garbageIds) { mkdirSync(join(root, '.git/objects', id.slice(0, 2)), { recursive: true }); writeFileSync(join(root, '.git/objects', id.slice(0, 2), id.slice(2)), 'garbage'); }
    // A garbage loose object where the absent parent belongs: Git reads it as missing, and rev-list stops at it without naming a commit.
    if (mode === '--garbage') { mkdirSync(join(root, '.git/objects/11'), { recursive: true }); writeFileSync(join(root, '.git/objects/11', '1'.repeat(38)), 'garbage'); }
    // A shallow file, as a builder could write it, naming every commit.
    if (mode === '--shallow-all') writeFileSync(join(root, '.git/shallow'), listedCommits.join('\n') + '\n');
    let where = root;
    if (['--shallow', '--shallow-two'].includes(mode)) { where = join(base, 'shallow'); execFileSync('git', ['clone', '-q', '--depth', String(n), `file://${root}`, where]); }
    const paths = JSON.stringify(['factotum.lock.json', 'tools/factotum/factory']);
    const result = ['--behind', '--behind-absent'].includes(mode) ? timeReaches(where, behind.head, behind.target, `objects.ownChanges(${JSON.stringify(behind.head)}, [${JSON.stringify(behind.target)}], ${paths})`)
      : mode === '--absent-own' ? timeReaches(where, git(where, ['rev-parse', 'HEAD']), start, `objects.ownChanges(${JSON.stringify(git(where, ['rev-parse', 'HEAD']))}, [${JSON.stringify(start)}], ${paths})`)
      : timeReaches(where, git(where, ['rev-parse', 'HEAD']), unrelated);
    console.log(JSON.stringify({ mode, n, ...(['--merges', '--quadratic'].includes(mode) ? { chain } : {}), ...(mode === '--gaps' ? { gaps: garbageIds.length } : {}), ...(oldGit ? { oldGit } : {}), commits: where !== root ? git(where, ['rev-list', '--missing=print', 'HEAD']).split('\n').filter(line => line && line[0] !== '?').length : listedCommits.length, refusalMs: Math.round(result.ms), found: result.found, gitProcesses: result.gitProcesses, maxRssMb: Math.round(result.maxRssMb) }));
  } finally { rmSync(base, { recursive: true, force: true }); }
  process.exit(0);
}
try {
  const root = join(base, 'app'); mkdirSync(root); git(root, ['init', '-qb', 'main']); git(root, ['config', 'user.email', 'm@example.invalid']); git(root, ['config', 'user.name', 'M']);
  for (let i = 0; i < 40; i++) writeFileSync(join(root, `file-${i}.txt`), `${i}\n`);
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'Base']);
  const total = Number(args[0] ?? 3000), releases = 6, per = Math.floor(total / releases);
  const bulk = (n, tag) => {
    const head = git(root, ['rev-parse', 'HEAD']); let stream = '';
    for (let i = 0; i < n; i++) stream += `commit refs/heads/main\ncommitter M <m@example.invalid> ${1700000000 + i} +0000\ndata ${`c ${tag} ${i}`.length}\nc ${tag} ${i}\n${i === 0 ? `from ${head}\n` : ''}M 100644 inline file-${i % 40}.txt\ndata ${`${tag}-${i}\n`.length}\n${tag}-${i}\n\n`;
    git(root, ['fast-import', '--quiet'], stream); git(root, ['reset', '-q', '--hard', 'main']);
  };
  for (let r = 0; r < releases; r++) {
    const out = join(base, `release-${r}`), built = buildRelease({ sourceDir: join(repo, 'starter'), outputDir: out, version: `9.0.${r}-measure`, allowWorkingTree: true });
    const prepared = prepareAdoption({ root, releaseDir: out, expectedDigest: built.manifestDigest, branch: `adopt-${r}`, worktreeDir: join(base, `wt-${r}`), initial: r === 0, ...(r === 0 ? { prefix: 'tools/factotum' } : {}) });
    git(prepared.worktree, ['add', '-A']); git(prepared.worktree, ['commit', '-qm', `Adopt ${r}`]); git(root, ['merge', '-q', '--ff-only', `adopt-${r}`]);
    git(root, ['worktree', 'remove', prepared.worktree]);
    bulk(per, `r${r}`);
  }
  // A target that is not in HEAD, as during a conflicted merge before it is concluded.
  const unrelated = git(root, ['commit-tree', git(root, ['rev-parse', 'HEAD^{tree}']), '-m', 'Unrelated target']);
  const fresh = script => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 }));
  const status = fresh(`const { adoptionStatus } = await import(${JSON.stringify(join(repo, 'starter/factory/distribution.mjs'))});
    const t = process.hrtime.bigint(), s = adoptionStatus({ root: ${JSON.stringify(root)} }); if (!s.clean) throw new Error('not clean');
    console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - t) / 1e6, maxRssMb: process.resourceUsage().maxRSS / 1024 }));`);
  const reaches = fresh(`const { VerifiedObjects } = await import(${JSON.stringify(join(repo, 'starter/factory/core/verified-git.mjs'))});
    const objects = new VerifiedObjects(${JSON.stringify(root)}), head = ${JSON.stringify(git(root, ['rev-parse', 'HEAD']))};
    const t = process.hrtime.bigint(), found = objects.reaches(head, ${JSON.stringify(unrelated)});
    console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - t) / 1e6, found }));`);
  const t = process.hrtime.bigint(); git(root, ['log', '--full-history', '--format=%H', '--', 'factotum.lock.json']); const logMs = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(JSON.stringify({ commits: Number(git(root, ['rev-list', '--count', 'HEAD'])), lockCommits: git(root, ['log', '--format=%H', '--', 'factotum.lock.json']).split('\n').length,
    coldAdoptionStatusMs: Math.round(status.ms), coldAdoptionStatusMaxRssMb: Math.round(status.maxRssMb), ancestryCheckMs: Math.round(reaches.ms), ancestryFound: reaches.found, plainGitLogMs: Math.round(logMs) }));
} finally { rmSync(base, { recursive: true, force: true }); }
