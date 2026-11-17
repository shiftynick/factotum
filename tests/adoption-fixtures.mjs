// Fixtures for the dev.87 adoption-lock and upgrade-recovery tests: a fictional root installation of
// release 1.0.0, release 1.1.0 to upgrade to, a remote target, and stub units. Every project, path and
// release here is fictional.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sandbox } from './helpers.mjs';
// Namespace imports, so that on a release without these exports the tests fail on their assertions.
import * as distribution from '../starter/factory/distribution.mjs';
import { prepareUpgrade, activateUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';

const { buildRelease, prepareAdoption } = distribution;
export const adoptionCheck = (root, options) => { const { reasons, warnings } = distribution.adoptionCheck ? distribution.adoptionCheck(root, options) : { reasons: distribution.adoptionDrift(root), warnings: [] }; return { reasons, warnings }; };
export const cli = join(process.cwd(), 'starter/factory/cli.mjs');
export const LOCK = 'factotum.lock.json';
export const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
export const sha256 = text => createHash('sha256').update(text).digest('hex');
export const readLock = root => JSON.parse(readFileSync(join(root, LOCK), 'utf8'));
export const writeLock = (root, lock) => writeFileSync(join(root, LOCK), JSON.stringify(lock, null, 2) + '\n');
export function adoptStatus(root, ...extra) { const ran = spawnSync(process.execPath, [cli, 'adopt', 'status', '--root', root, ...extra], { encoding: 'utf8' }); return { code: ran.status, out: ran.stdout, err: ran.stderr }; }

export function release(f, version, marker) {
  const source = join(f.base, `source-${version}`);
  put(source, 'factory/cli.mjs', `console.log(${JSON.stringify(marker)});\n`); put(source, 'factory/core/configuration.mjs', 'export const validateConfig = config => config;\n');
  put(source, 'project/GOVERNANCE.md', 'Fictional template governance\n'); put(source, 'VERSION', 'development\n');
  put(source, 'compatibility.json', JSON.stringify({ schemaVersion: 1, configVersion: 1, projectProtocolVersion: 1, recordLayouts: ['inline', 'separate-intents'] }));
  const dir = join(f.base, `release-${version}`); return { dir, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) };
}
// The attack: a managed file replaced, and its new SHA-256 written into the lock. The lock's release
// record (manifest and payload digests) stays the pinned release's.
export const SUBSTITUTE = 'export const validateConfig = config => config; // substituted\n';
export function substitute(checkout) {
  put(checkout, 'factory/core/configuration.mjs', SUBSTITUTE);
  const lock = readLock(checkout), digests = JSON.stringify(lock.release);
  lock.managedFiles.find(file => file.path === 'factory/core/configuration.mjs').sha256 = sha256(SUBSTITUTE);
  writeLock(checkout, lock); assert.equal(JSON.stringify(lock.release), digests);
}
// A root lock as releases before dev.87 wrote it: no layout evidence.
export function earlierShape(checkout) { const { rootLayout, ...lock } = readLock(checkout); writeLock(checkout, lock); }

// A root installation of 1.0.0, adopted with this release's code or (legacy) with an earlier one's
// lock shape; `tamper` edits the adoption commit itself, as someone writing to the target could.
export function fixture(t, { legacy = false, tamper } = {}) {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const one = release(f, '1.0.0', 'one'), installed = prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true });
  if (legacy) earlierShape(installed.worktree); tamper?.(installed.worktree);
  git(installed.worktree, ['add', '-A']); git(installed.worktree, ['commit', '-qm', 'Adopt 1.0.0']); git(f.root, ['merge', '--ff-only', 'chore/install']);
  const two = release(f, '1.1.0', 'two');
  const options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-1.1.0', worktreeDir: join(f.base, 'review-1.1.0') };
  const systemctl = [], active = new Set(['factotum-console.service']);
  const run = async (binary, args) => { if (binary === 'systemctl') { systemctl.push(args.slice(1).join(' ')); const [verb, ...rest] = args.slice(1); if (verb === 'show') return { code: 0, stdout: `{ path=/usr/bin/node ; argv[]=/usr/bin/node ${f.root}/factory/console/console.mjs }` }; if (verb === 'is-active') return { code: active.has(rest.at(-1)) ? 0 : 3 }; if (verb === 'stop') active.delete(rest[0]); if (verb === 'start') active.add(rest[0]); } return { code: 0, stdout: '', stderr: '' }; };
  const cliCalls = [], runCli = async args => { cliCalls.push(args.slice(0, 2).join(' ')); return { code: 0, stdout: '{}', stderr: '' }; };
  return { ...f, one, two, options, systemctl, active, run, runCli, cliCalls };
}
// The reviewed adoption of 1.1.0 lands on the remote target through a squash-merged pull request;
// `tamper` edits it on its way there.
// A bare remote holding the checkout's branch as the project's configured target, and a second clone
// of it (`other`) that changes the target the way a pull request merged by hand would.
export function remoteTarget(f) {
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['config', 'commit.gpgsign', 'false']); git(other, ['checkout', '-q', target]);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  return { target, other };
}
export function landed(t, { tamper, legacy = false } = {}) {
  const f = fixture(t, { legacy }), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const { target, other } = remoteTarget(f);
  git(other, ['fetch', '-q', f.root, `${f.options.branch}:review`]); git(other, ['merge', '-q', '--squash', 'review']); tamper?.(other); git(other, ['add', '-A']); git(other, ['commit', '-qm', 'Adopt 1.1.0 (#1)']); git(other, ['push', '-q', 'origin', target]);
  return { ...f, other, target, head: git(f.root, ['rev-parse', 'HEAD']), remoteHead: git(other, ['rev-parse', 'HEAD']) };
}
export const activate = (f, extra = {}) => activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, `backup-${Math.random().toString(36).slice(2)}`), run: f.run, runCli: f.runCli, ...extra });
export const stops = f => f.systemctl.filter(line => line.startsWith('stop'));
