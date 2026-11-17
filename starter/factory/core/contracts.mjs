import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateOperations } from './operations.mjs';

export const PROTOCOL_VERSION = 1;
// SCHEMA_VERSION is what init creates. A database reaches schema 2 only through
// the explicit offline authority migration (operations/authority-migration.mjs);
// binaries that know only schema 1 refuse it by their equality check.
export const SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const fileDigest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function id(value, label = 'id') {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value), `invalid ${label}`);
  return value;
}
// An id a caller names to read a record that already exists (status --inbox/--flow/--task, the
// project service's and the console's read routes). New ids a caller chooses still go through id()
// (at most 128 characters); Factotum builds longer ones from them (dev.86, J8).
//
// GENERATED_ID_MAX is the longest id any generator can build, with every part at its validated
// bound: a caller-chosen flow id 128, a target branch name TARGET_BRANCH_MAX (200), a digest 64, a
// generated time 24, a head prefix 12, the outcome "completed" 9. The longest is the notice of the
// maintenance flow that brings one target up to date with another after it moved outside the
// factory (operations/main-freshness.mjs, ensureTargetSync):
//   job id    "target-sync:outside:" 20 + from 200 + ":" + into 200 + ":" + head 12        = 434
//   flow id   "maintenance:" 12 + job id 434                                               = 446
//   notice id "flow-notice:" 12 + flow id 446 + ":completed:" 11 + digest 64               = 533
// Every other form is shorter: its cleanup notice 461; the notice of
// "target-sync:<flow id>:<into>" 440; of "main-timeout-retry:<target>:<time>" 343; of
// "main-refresh:<target>:<time>" 337; of "post-merge-main:<flow id>" 243; the forms without a
// target name or flow id are under 200. docs/changes/dev86-console-j-items.md lists them all, and
// tests/dev86-console-j-items.test.mjs builds each through its generator.
//
// RECORD_ID_MAX leaves headroom over it. The lookup accepts the generated ids' characters plus "/",
// which a target branch name carries.
export const GENERATED_ID_MAX = 533;
export const RECORD_ID_MAX = 640;
export function recordId(value, label = 'id') {
  assert(typeof value === 'string' && value.length <= RECORD_ID_MAX && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value), `invalid ${label}: at most ${RECORD_ID_MAX} letters, digits and . _ : / -, starting with a letter or digit`);
  return value;
}
// A target branch name (repository.target, a workflow's target, repository.syncTargets): at most
// TARGET_BRANCH_MAX characters of letters, digits, ".", "_", "/" and "-", starting with a letter or
// digit, without "..". Generated job, flow and notice ids embed target names, so this rule is what
// bounds them (dev.86, J8: GENERATED_ID_MAX below).
export const TARGET_BRANCH_MAX = 200;
export const TARGET_BRANCH_RULE = `at most ${TARGET_BRANCH_MAX} characters of letters, digits, ".", "_", "/" and "-", starting with a letter or digit, without ".."`;
export const isTargetBranch = value => typeof value === 'string' && value.length <= TARGET_BRANCH_MAX && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..');
// The refusal for a name that breaks the rule: what it is, the rule, and what to do.
export function assertTargetBranch(value, setting) {
  const shown = typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : `a ${typeof value}`;
  assert(isTargetBranch(value), `${setting} must be a branch name of ${TARGET_BRANCH_RULE}; ${shown} is not. Factotum builds record ids from target names, so use a branch whose name follows the rule (rename the branch, or point ${setting} at one that does), then run doctor`);
  return value;
}
export function note(value) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 4000, 'note is required: a sentence saying why (1-4000 characters)');
  return value.trim();
}
export function atomicJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${uid()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function validateWorkflow(workflow) {
  assert(workflow?.version === 1 && workflow.nodes && typeof workflow.nodes === 'object', 'unsupported workflow');
  id(workflow.start, 'workflow start');
  assert(Object.hasOwn(workflow.nodes, workflow.start), 'missing workflow start');
  assert(Object.keys(workflow.nodes).length <= 64, 'workflow too large');
  assert(Number.isSafeInteger(workflow.maxTransitions ?? 100) && (workflow.maxTransitions ?? 100) > 0, 'invalid workflow transition bound');
  for (const [key, node] of Object.entries(workflow.nodes)) {
    id(key, 'node');
    assert(['effect', 'question', 'wait', 'end'].includes(node.kind), 'invalid node kind');
    if (node.maxVisits !== undefined) assert(Number.isSafeInteger(node.maxVisits) && node.maxVisits > 0, 'invalid visit bound');
    if (node.kind === 'effect') {
      assert(node.action ? typeof node.action.operation === 'string' && node.action.operation : Array.isArray(node.argv) && node.argv.length && node.argv.every(x => typeof x === 'string' && !x.includes('\0')), 'effect requires trusted argv or installed action');
      assert(node.action?.guidance === undefined || typeof node.action.guidance === 'string' && node.action.guidance.trim() && node.action.guidance.length <= 4000, 'action guidance must be text of at most 4000 characters');
      assert(Number.isSafeInteger(node.timeoutMs) && node.timeoutMs > 0 && node.timeoutMs <= 3_600_000, `effect ${key} timeoutMs must be a whole number of milliseconds from 1 to 3600000 (one hour); got ${node.timeoutMs}`);
      assert((node.maxCostMicros ?? 0) === 0, 'metered operations require a separately qualified ceiling adapter');
      assert(typeof node.next === 'string' && typeof node.onFailure === 'string', 'effect success and failure transitions required');
    }
    if(node.kind==='wait'){
      assert(node.untilFrom&&typeof node.untilFrom.step==='string'&&typeof node.untilFrom.field==='string'&&node.untilFrom.field,'wait result field required');
      assert(Object.hasOwn(workflow.nodes,node.untilFrom.step),'wait result step missing');
      assert(Number.isSafeInteger(node.maxWaitMs)&&node.maxWaitMs>0&&node.maxWaitMs<=36*3600000,'invalid timer wait bound');
      assert(typeof node.next==='string'&&typeof node.onFailure==='string','wait transitions required');
    }
    if (node.kind === 'question') {
      assert(typeof node.question === 'string' && node.question.trim(), 'question text required');
      assert(node.answers && Object.keys(node.answers).length > 0, 'question answers required');
      assert(['operator', 'orchestrator'].includes(node.role), 'question role required');
      assert(node.remind === undefined || node.remind === 'never' || Number.isSafeInteger(node.remind) && node.remind >= 1800000, 'question remind must be "never" or at least 30 minutes');
    }
    if (node.kind === 'end') assert(['completed', 'failed', 'stopped'].includes(node.outcome), 'invalid terminal outcome');
    for (const next of edges(node)) assert(Object.hasOwn(workflow.nodes, next), `unknown workflow edge: ${next}`);
  }
  // Removing explicitly bounded nodes must leave a DAG: every possible cycle crosses a bound.
  const active = new Set(), visited = new Set();
  function walk(key) {
    const node = workflow.nodes[key];
    if (node.maxVisits || visited.has(key)) return;
    assert(!active.has(key), 'unbounded workflow cycle');
    active.add(key);
    for (const next of edges(node)) walk(next);
    active.delete(key); visited.add(key);
  }
  for (const key of Object.keys(workflow.nodes)) walk(key);
  validateOperations(workflow);
  return digest(workflow);
}
function edges(node) {
  if (node.kind === 'effect'||node.kind === 'wait') return [node.next, node.onFailure, ...Object.values(node.resultEdges ?? {})].filter(Boolean);
  if (node.kind === 'question') return Object.values(node.answers);
  return [];
}
