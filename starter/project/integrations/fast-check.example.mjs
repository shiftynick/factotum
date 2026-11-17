#!/usr/bin/env node
// Example fast check (project-owned; copy to project/integrations/ and adapt).
//
// A fast check decides a mechanical project rule that a reviewer would otherwise have to raise,
// so a violation goes straight back to the builder instead of costing a review. Keep it cheap:
// read the candidate, do not build or run the test suite here (that is the gate's job).
//
// Example rule: a change that edits files under src/ also changes something under test/.
// Declare it in the check's "rules" so reviewers are told not to raise it.
//
// Exit codes: 0 the rule holds; 1 the rule is violated (the builder corrects it);
// 78 a prerequisite is missing that the builder cannot repair (commission it in holdExitCodes).
// Must not change the checkout. Child processes get stdin ignored: some provider and supervisor
// sandboxes refuse a piped child stdin.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const git = args => spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
// Write a concise report where the factory reads it; the builder receives a bounded excerpt.
const report = text => { if (process.env.FACTOTUM_CHECK_DIAGNOSTICS) writeFileSync(process.env.FACTOTUM_CHECK_DIAGNOSTICS, `${text}\n`); console.log(text); };

const target = process.env.FACTOTUM_TARGET || 'main';
const base = git(['merge-base', 'HEAD', `refs/remotes/origin/${target}`]);
if (base.status !== 0) { report(`Prerequisite: origin/${target} is not available in this checkout, so the change cannot be compared with its target.`); process.exit(78); }
const diff = git(['diff', '--name-only', `${base.stdout.trim()}...HEAD`]);
if (diff.status !== 0) { report(`Prerequisite: git diff failed: ${diff.stderr.trim()}`); process.exit(78); }

const changed = diff.stdout.split('\n').filter(Boolean);
const source = changed.filter(path => path.startsWith('src/')), tests = changed.filter(path => path.startsWith('test/'));
if (source.length && !tests.length) {
  report(`RULE tests-with-source: the change edits ${source.join(', ')} but changes nothing under test/. Add or update the tests that cover it.`);
  process.exit(1);
}
console.log(`tests-with-source: ${source.length} source file(s), ${tests.length} test file(s) changed`);

// Optional rules for projects that run more than one flow at once (policy.maxFlows > 1). A task's
// declared paths keep overlapping work apart at admission but do not stop a builder from changing
// other files. Since dev.82 checks receive them (FACTOTUM_TASK_PATHS, one per line; empty when the
// task declares none) and the reviewer is told about out-of-path files.
//
// Rule task-paths (off by default; set TASK_PATHS_RULE to true): every changed file is inside the
// task's declared paths, apart from SHARED ones. If you use it, declare it in the check's "rules",
// for example "A change stays inside its task's declared paths".
const TASK_PATHS_RULE = false;
const SHARED = ['test/', 'docs/', 'CHANGELOG.md'];
const declared = (process.env.FACTOTUM_TASK_PATHS ?? '').split('\n').filter(Boolean);
if (TASK_PATHS_RULE && declared.length) {
  const inside = path => declared.some(p => p === '.' || path === p || path.startsWith(`${p}/`));
  const outside = changed.filter(path => !inside(path) && !SHARED.some(prefix => path.startsWith(prefix)));
  if (outside.length) {
    report(`RULE task-paths: the change edits files outside the task's declared paths (${declared.join(', ')}): ${outside.join(', ')}. Keep the change inside them, or ask for the task's paths to be changed.`);
    process.exit(1);
  }
  console.log(`task-paths: every changed file is inside ${declared.join(', ')}`);
}

// Rule one-area, for releases before dev.82 or tasks without declared paths: a project whose tasks
// each stay inside one area can enforce that here: list the areas; files under SHARED may be
// changed by any task. Leave AREAS empty to switch the rule off. If you use it, declare it in the
// check's "rules" too, for example "A change stays inside one area (src/billing/ or src/reports/)".
const AREAS = []; // for example ['src/billing/', 'src/reports/']
if (AREAS.length) {
  const outside = changed.filter(path => !SHARED.some(prefix => path.startsWith(prefix)));
  const touched = AREAS.filter(area => outside.some(path => path.startsWith(area)));
  const unassigned = outside.filter(path => !AREAS.some(area => path.startsWith(area)));
  if (touched.length > 1 || unassigned.length) {
    report(`RULE one-area: the change touches ${touched.length > 1 ? `several areas (${touched.join(', ')})` : ''}${touched.length > 1 && unassigned.length ? ' and ' : ''}${unassigned.length ? `files outside every area (${unassigned.join(', ')})` : ''}. Keep the change inside its task's area; anything else belongs in a separate task.`);
    process.exit(1);
  }
  console.log(`one-area: ${touched[0] ?? 'no area'} (${outside.length} file(s) outside shared paths)`);
}
