import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { inspect, requestAbort } from '../starter/factory/core/effects.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The bound only stops a stuck test; waits finish as soon as the condition holds.
// It is generous because a loaded host can take seconds to start a supervisor.
// Without an explicit explain, a timeout reports every open sandbox's attempts, flows and recent events.
export async function until(fn, { timeout = 60000, tick = async () => {}, explain = openSandboxState } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { await tick(); const value = fn(); if (value) return value; await delay(25); }
  let detail; try { detail = explain(); } catch (error) { detail = `state unavailable: ${error.message}`; }
  throw new Error(`timed out waiting for rehearsal state${detail ? `: ${detail}` : ''}`);
}
const openSandboxes = new Set();
const safeInspect = (store, attempt) => { try { return inspect(store, attempt); } catch (error) { return { error: error.message }; } };
// The attempt, its inspected effect, its flow and recent events, for a wait that times out.
export const attemptState = (f, attempt) => () => JSON.stringify({ inspect: safeInspect(f.store, f.store.need('attempt', attempt.id)), attempt: f.store.need('attempt', attempt.id), flow: f.store.need('flow', attempt.flowId), events: f.store.events(10) });
export function sandboxState(store) {
  return JSON.stringify({
    attempts: store.all('attempt').slice(-5).map(attempt => { const { intent, ...rest } = attempt; return { ...rest, inspect: safeInspect(store, attempt) }; }),
    flows: store.all('flow').slice(-5).map(({ id, state, step, stopReason, attemptId, abortRequested }) => ({ id, state, step, stopReason, attemptId, abortRequested })),
    events: store.events(10),
  });
}
function openSandboxState() { return [...openSandboxes].map(store => { try { return sandboxState(store); } catch (error) { return `state unavailable: ${error.message}`; } }).join('\n') || null; }
export function workflow(argv, question = false) {
  return { version: 1, start: 'work', nodes: {
    // Generous: it bounds a stuck fixture, and no test here relies on it firing.
    work: { kind: 'effect', argv, timeoutMs: 60000, next: question ? 'decision' : 'done', onFailure: 'failed' },
    ...(question ? { decision: { kind: 'question', question: 'Continue fictional rehearsal?', role: 'operator', answers: { continue: 'done', stop: 'stopped' } }, stopped: { kind: 'end', outcome: 'stopped' } } : {}),
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' },
  } };
}
export function sandbox(t, { argv = [process.execPath, '-e', 'console.log("synthetic")'], question = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fct-test-')), root = join(base, 'repo'), stateDir = join(base, 'state');
  mkdirSync(root); writeFileSync(join(root, 'input.txt'), 'fictional baseline\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['add', '.'], ['commit', '-qm', 'Fictional baseline']]) execFileSync('git', args, { cwd: root });
  const project = initProject({ stateDir, root, name: 'Fictional project', workflow: workflow(argv, question), supervisor: 'process' });
  const store = new Store(stateDir), engine = new Engine(store);
  const command = (operation, payload, { actor = 'operator', commandId = uid() } = {}) => executeCommand(store, { protocolVersion: 1, projectId: project.projectId, commandId, operation, payload, actor });
  const task = command('task.put', { task: { id: 'task-1', title: 'Fictional feature', acceptance: ['Observed fixture behavior'] } }).result;
  const start = () => { command('task.approve', { taskId: task.id, revision: store.need('task', task.id).revision }); return command('flow.start', { taskId: task.id, flowId: 'flow-1' }); };
  openSandboxes.add(store);
  t.after(async () => {
    openSandboxes.delete(store);
    // Keep asking until every attempt is quiescent: a supervisor still starting is asked to stop,
    // then killed if it has not recorded ownership after the launch abort grace.
    const live = () => store.all('attempt').filter(a => ['running', 'launching'].includes(inspect(store, a).kind));
    const end = Date.now() + 30000;
    let pending = live();
    for (; pending.length && Date.now() < end; pending = live()) { for (const attempt of pending) await requestAbort(store, attempt); await delay(25); }
    const active = pending.length ? pending.map(a => ({ id: a.id, status: a.status, inspect: inspect(store, a), launchAbort: a.launchAbort ?? null })) : null;
    const detail = active ? sandboxState(store) : null;
    store.close(); rmSync(base, { recursive: true, force: true });
    if (active) throw new Error(`sandbox cleanup: attempts still active after 30 s: ${JSON.stringify(active)}\n${detail}`);
  });
  return { base, root, stateDir, project, store, engine, command, task, start };
}
