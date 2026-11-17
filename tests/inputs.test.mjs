import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandbox } from './helpers.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { copyInputs, inputsBrief } from '../starter/factory/operations/inputs.mjs';

test('declared inputs are validated, hold admission until present and matching, and are briefed', t => {
  const f = sandbox(t);
  assert.equal(f.command('task.put', { task: { ...f.task, inputs: [{ path: '../outside' }] } }).status, 'rejected');
  assert.equal(f.command('task.put', { task: { ...f.task, inputs: [{ path: 'data/a.csv', sha256: 'nope' }] } }).status, 'rejected');
  mkdirSync(join(f.root, 'data'), { recursive: true }); writeFileSync(join(f.root, 'data/a.csv'), 'x,y\n');
  const hash = createHash('sha256').update('x,y\n').digest('hex');
  const put = f.command('task.put', { task: { ...f.task, inputs: [{ path: 'data/a.csv', sha256: hash, note: 'survey export' }, { path: 'data/b.csv' }] } });
  assert.equal(put.status, 'completed', put.error);
  const reasons = admissionReasons(f.store, f.store.need('task', f.task.id));
  assert.ok(reasons.includes('input missing: data/b.csv') && !reasons.some(r => r.includes('a.csv')), reasons.join('; '));
  writeFileSync(join(f.root, 'data/a.csv'), 'changed\n');
  assert.ok(admissionReasons(f.store, f.store.need('task', f.task.id)).includes('input changed: data/a.csv does not match its sha256'));
  assert.match(inputsBrief([{ path: 'data/a.csv', note: 'survey export' }]), /no network.*\n- data\/a\.csv: survey export/s);
});

test('git-ignored inputs are copied into the worktree; untracked unignored ones are refused', t => {
  const root = mkdtempSync(join(tmpdir(), 'fct-inputs-')), git = (...a) => execFileSync('git', a, { cwd: root });
  git('init', '-q'); writeFileSync(join(root, '.gitignore'), 'data/\n'); git('add', '.'); git('-c', 'user.email=f@example.invalid', '-c', 'user.name=F', 'commit', '-qm', 'base');
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data/a.csv'), 'rows\n'); writeFileSync(join(root, 'loose.txt'), 'x');
  const worktree = join(root, '..', `${root.split('/').pop()}-wt`); git('worktree', 'add', '-q', worktree);
  t.after(() => git('worktree', 'remove', '--force', worktree));
  assert.deepEqual(copyInputs(root, worktree, [{ path: 'data/a.csv' }]), ['data/a.csv']);
  assert.equal(readFileSync(join(worktree, 'data/a.csv'), 'utf8'), 'rows\n');
  assert.throws(() => copyInputs(root, worktree, [{ path: 'loose.txt' }]), /neither in the repository nor git-ignored/);
});
