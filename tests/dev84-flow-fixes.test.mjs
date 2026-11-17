// dev.84 flow fixes from the dev.83 readiness re-test (docs/changes/dev84-flow-fixes.md): the
// wrong-candidate notice says whether the pull request moved or the approval named another commit
// (H1), and the triage example answers --help (H12). Merge serialisation (H8) and the provider
// turn limit (H9) have their own files; H10 is in admission-capacity, H13 in trial-code-items.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, adoptCandidate } from '../starter/factory/adapters/workspace/index.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';

const STARTER = join(process.cwd(), 'starter');
const rev = async (cwd, ref = 'HEAD') => (await git(cwd, ['rev-parse', ref])).stdout;
const commitFile = async (cwd, name, text, message) => { await writeFile(join(cwd, name), text); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', message]); return rev(cwd); };

// A repository with a remote, a target `main` and an outside pull request #1 at refs/pull/1/head.
async function scenario(t) {
  const directory = await mkdtemp(join(tmpdir(), 'adopt-h1-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root'), remote = join(directory, 'remote.git'); await mkdir(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fictional Developer']); await git(root, ['config', 'user.email', 'developer@example.invalid']);
  const first = await commitFile(root, 'app.txt', 'initial\n', 'initial');
  await git(root, ['init', '--bare', remote]); await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  await git(root, ['checkout', '-b', 'outside']);
  const approved = await commitFile(root, 'outside.txt', 'outside\n', 'Outside change');
  const later = await commitFile(root, 'outside.txt', 'outside, more\n', 'Outside change, continued');
  await git(root, ['push', 'origin', 'HEAD:refs/pull/1/head']); await git(root, ['checkout', 'main']);
  return { directory, root, first, approved, later };
}
const pr = (s, extra = {}) => ({ number: 1, state: 'open', draft: false, merged: false, baseRef: 'main', url: 'https://example.invalid/pull/1', head: s.later, base: s.first, commits: 2, ...extra });
const forge = (s, { commits = [s.approved, s.later], ...extra } = {}) => ({ readPR: async () => pr(s, extra), ...(commits ? { readPRCommits: async () => commits.map(sha => ({ sha, message: 'Fictional' })) } : {}) });
const headRow = async (s, expectedHead, f) => {
  let row;
  await assert.rejects(adoptCandidate({ root: s.root, stateDir: join(s.directory, 'state'), projectId: 'fictional', flowId: `adopt-${uid().slice(0, 8)}`, number: 1, target: 'main', expectedHead, expectedBase: s.first, forge: f }), error => {
    row = error.adoptionMismatch.mismatches.find(r => r.field === 'head'); return Boolean(row);
  });
  return row;
};

test('H1: an approved commit that is an earlier commit of the pull request is described as observed, without guessing when', async t => {
  const s = await scenario(t);
  const row = await headRow(s, s.approved, forge(s));
  assert.doesNotMatch(row.fix, /moved|after it was approved/, 'neither a push after approval nor a mistaken approval is assumed');
  assert.match(row.fix, new RegExp(`^the approved commit ${s.approved.slice(0, 12)} is an earlier commit of this pull request; its head is now ${s.later.slice(0, 12)}; review head ${s.later}, then abandon this flow \\(flow\\.abandon\\) and start a new one \\(flow\\.start\\) with candidate\\.head ${s.later}$`));
});

test('H1: an approval that named a commit of the target says so, not that the pull request moved', async t => {
  const s = await scenario(t);
  // The report's case: the operator typed the target's head as candidate.head.
  const row = await headRow(s, s.first, forge(s));
  assert.doesNotMatch(row.fix, /moved/);
  assert.match(row.fix, new RegExp(`^the approved head ${s.first.slice(0, 12)} is a commit on main, not the pull request's head: the approval named another commit; review head ${s.later}, then abandon this flow`));
});

test('H1: a head the pull request never had, and a head that cannot be placed, are worded without guessing', async t => {
  const s = await scenario(t), unknown = 'e'.repeat(40);
  let row = await headRow(s, unknown, forge(s));
  assert.match(row.fix, /^the approved head eeeeeeeeeeee is not the pull request's head or one of its commits: the approval named another commit, or the pull request was force-pushed after approval; review head /);
  // Without the commit list (a forge without it, or a failed read): the neutral wording.
  row = await headRow(s, unknown, forge(s, { commits: null }));
  assert.match(row.fix, /^the approved head is not the pull request's head \(it may have moved since approval, or the approval named another commit\); review head /);
  row = await headRow(s, unknown, { ...forge(s), readPRCommits: async () => { throw new Error('fictional read failure'); } });
  assert.match(row.fix, /^the approved head is not the pull request's head \(it may have moved since approval/);
});

test('H12: triage --help prints the usage and exits 0, wherever it appears', () => {
  const script = join(STARTER, 'project/integrations/triage.example.mjs');
  for (const args of [['--help'], ['-h'], ['--counts', '--help'], ['--log', '--help']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: '' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Triage rules for a T3 triage proxy thread\./);
    for (const mode of ['--timer', '--digest', '--sent <sendId>', '--judged-absorb <deliveryId>', '--counts', '--missed', '--help']) assert.ok(result.stdout.includes(mode), `${mode} listed`);
  }
  // A real missing value is still refused (dev.83 G21).
  const missing = spawnSync(process.execPath, [script, '--counts', '--since'], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.equal(missing.stderr, 'triage: --since needs a value\n');
});
