import { NO_PLANTED_COMMANDS } from '../core/git-options.mjs';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { assert } from '../core/contracts.mjs';

// Offline inputs a task declares: files or directories the work needs that are not fetched
// during it (model steps have no network). They must exist in the project checkout before the
// task starts; the factory copies git-ignored ones into the flow's worktree, never commits them,
// and lists them in every step's brief.
export function validateInputs(inputs) {
  if (inputs === undefined) return;
  assert(Array.isArray(inputs) && inputs.length <= 32, 'inputs must be a list of at most 32 entries');
  for (const row of inputs) {
    assert(row && typeof row === 'object' && Object.keys(row).every(k => ['path', 'sha256', 'note'].includes(k)), 'each input is {path, sha256?, note?}');
    assert(typeof row.path === 'string' && row.path.trim() && !isAbsolute(row.path) && !row.path.split('/').some(p => p === '..' || p === '') && !row.path.includes('\0'), `input path ${row.path} must be relative and inside the project`);
    assert(row.sha256 === undefined || /^[a-f0-9]{64}$/.test(row.sha256), `input ${row.path}: sha256 must be 64 hex characters`);
    assert(row.note === undefined || typeof row.note === 'string' && row.note.length <= 500, `input ${row.path}: note must be text of at most 500 characters`);
  }
}
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

// Why a task's inputs are not ready in the project checkout (empty when they are).
export function inputReasons(root, task) {
  const reasons = [];
  for (const input of task?.inputs ?? []) {
    const path = join(root, input.path);
    if (!existsSync(path)) { reasons.push(`input missing: ${input.path}${input.note ? ` (${input.note})` : ''}`); continue; }
    if (input.sha256 && statSync(path).isFile() && sha256(path) !== input.sha256) reasons.push(`input changed: ${input.path} does not match its sha256`);
  }
  return reasons;
}

// Copy git-ignored inputs into a new worktree. Tracked inputs are already there; an input that
// is neither tracked nor ignored would be committed by the flow, so it is refused.
export function copyInputs(root, worktree, inputs = [], { onlyMissing = false } = {}) {
  const copied = [];
  for (const input of inputs) {
    const target = join(worktree, input.path);
    if (onlyMissing && existsSync(target)) continue;
    let ignored = false; try { execFileSync('git', [...NO_PLANTED_COMMANDS, 'check-ignore', '-q', input.path], { cwd: worktree, timeout: 5000 }); ignored = true; } catch {}
    if (!ignored) { assert(existsSync(target), `input ${input.path} is neither in the repository nor git-ignored; commit it, or ignore it so it is copied in`); continue; }
    mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, input.path), target, { recursive: true });
    copied.push(input.path);
  }
  return copied;
}
export const inputsBrief = inputs => inputs?.length ? `Offline inputs (already in the worktree; there is no network, do not fetch them; never commit git-ignored ones):\n${inputs.map(i => `- ${i.path}${i.note ? `: ${i.note}` : ''}`).join('\n')}\n` : '';
