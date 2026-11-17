#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const reference = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
for (const flag of flags) assert(['--keep', '--serve', '--systemd', '--ui-demo'].includes(flag), `Unknown option: ${flag}`);
const serve = flags.has('--serve');
const uiDemo = flags.has('--ui-demo');
assert(!uiDemo || serve, '--ui-demo requires --serve');
const supervisor = flags.has('--systemd') ? 'systemd' : 'process';
const runtime = await mkdtemp(join(tmpdir(), 'factotum-eval-'));
const projects = [];
let consoleInstance;
const cleanups = [];
let interrupted = false;
let preserveRuntime = serve || flags.has('--keep');

function command(argv, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) throw new Error(`${argv[0]} could not run: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${JSON.stringify(argv)} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout).slice(-4000)}`);
  }
  return { exitCode: result.status, signal: result.signal };
}

function workflow(patch, check) {
  return {
    version: 1, start: 'build', nodes: {
      build: { kind: 'effect', argv: ['git', 'apply', patch], timeoutMs: 10_000, next: 'review', onFailure: 'failed' },
      review: { kind: 'effect', argv: ['git', 'diff', '--check'], timeoutMs: 10_000, preserveInput: true, evidence: 'rehearsal:diff-check', next: 'gate', onFailure: 'failed' },
      gate: { kind: 'effect', argv: check, timeoutMs: 10_000, preserveInput: true, evidence: 'rehearsal:acceptance', next: 'decision', onFailure: 'failed' },
      decision: { kind: 'question', question: 'Accept synthetic rehearsal result?', role: 'operator', requireEvidence: ['rehearsal:diff-check', 'rehearsal:acceptance'], answers: { continue: 'done', stop: 'stopped' } },
      done: { kind: 'end', outcome: 'completed' },
      failed: { kind: 'end', outcome: 'failed' },
      stopped: { kind: 'end', outcome: 'stopped' },
    },
  };
}

async function until(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!interrupted && Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(interrupted ? 'Evaluation interrupted' : `Timed out waiting for ${description}`);
}

function canonicalCommand(project, operation, payload) {
  return project.executeCommand(project.store, {
    protocolVersion: 1, projectId: project.identity.projectId,
    commandId: randomUUID(), operation, payload, actor: 'operator',
  });
}

async function prepare(scenario) {
  const root = join(runtime, 'projects', scenario.id);
  const stateDir = join(runtime, 'state', scenario.id);
  await mkdir(dirname(root), { recursive: true });
  await cp(join(reference, scenario.example), root, { recursive: true });
  // Copy all starter contents: evaluation must run the adopted copy's modules.
  await cp(join(reference, 'starter'), root, { recursive: true });
  command(['git', 'init', '-b', 'main'], root);
  command(['git', 'config', 'user.name', 'Fictional Evaluation Operator'], root);
  command(['git', 'config', 'user.email', 'evaluation@example.invalid'], root);
  command(['git', 'config', 'commit.gpgsign', 'false'], root);
  command(['git', 'config', 'core.hooksPath', '/dev/null'], root);
  command(['git', 'add', '.'], root);
  command(['git', 'commit', '-m', 'Initial fictional evaluation project'], root);
  const baseline = command(scenario.baseline.argv, root);
  const before = command(scenario.check.argv, root, { allowFailure: true });
  assert.equal(before.exitCode, 1, `${scenario.id}: feature acceptance must fail normally on the baseline`);

  const copied = path => import(pathToFileURL(join(root, 'factory', path)).href);
  const [{ Store, initProject }, { executeCommand }, { Engine }, { startProjectService }] = await Promise.all([
    copied('core/store.mjs'), copied('core/project.mjs'), copied('core/engine.mjs'), copied('service/project-service.mjs'),
  ]);
  const identity = initProject({ stateDir, root, name: scenario.title, supervisor, workflow: workflow(join(reference, 'evals', 'scenarios', scenario.build.patch), scenario.check.argv) });
  const project = { scenario, root, stateDir, identity, store: new Store(stateDir), executeCommand, baseline, before };
  projects.push(project); // Register cleanup ownership before any later operation can fail.
  const task = canonicalCommand(project, 'task.put', { task: { id: 'feature-1', title: scenario.title, acceptance: scenario.acceptance } });
  assert.equal(task.status, 'completed', task.error);
  const rejected = canonicalCommand(project, 'flow.start', { taskId: 'feature-1', flowId: 'flow-1' });
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error, /approval/i);
  assert.equal(project.store.all('attempt').length, 0, 'unapproved launch must not prepare effects');
  assert.equal(canonicalCommand(project, 'task.approve', { taskId: 'feature-1', revision: task.result.revision }).status, 'completed');
  assert.equal(canonicalCommand(project, 'flow.start', { taskId: 'feature-1', flowId: 'flow-1' }).status, 'completed');
  // Exercise the copied engine before its service takes exclusive ticking ownership.
  await new Engine(project.store).tick();
  project.service = await startProjectService({ stateDir, socketPath: join(stateDir, 'project.sock'), tickMs: 75, run: true });
  return project;
}

async function openConsole() {
  const { startConsole } = await import(pathToFileURL(join(projects[0].root, 'factory', 'console', 'console.mjs')).href);
  consoleInstance = await startConsole({ stateDir: join(runtime, 'console'), port: 0 });
  for (const project of projects) project.binding = await consoleInstance.registerProject({ socketPath: project.service.socketPath });
  const page = await fetch(consoleInstance.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = html.match(/<meta\s+name="factotum-csrf"\s+content="([^"]+)"/i)?.[1];
  assert(csrf, 'console page must expose its request token');
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'console page must establish a session');
  return async (path, body) => {
    const response = await fetch(`${consoleInstance.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-factotum-csrf': csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
}

try {
  const names = (await readdir(join(reference, 'evals', 'scenarios'))).filter(name => name.endsWith('.json')).sort();
  assert.equal(names.length, 2, 'the initial rehearsal expects two fictional stacks');
  for (const name of names) await prepare(JSON.parse(await readFile(join(reference, 'evals', 'scenarios', name), 'utf8')));
  assert.notEqual(projects[0].identity.projectId, projects[1].identity.projectId);
  const consoleRequest = await openConsole();
  await until(() => {
    for (const project of projects) {
      const flow = project.store.need('flow', 'flow-1');
      assert(!['failed', 'stopped'].includes(flow.state), `${project.scenario.id}: ${flow.stopReason || flow.state}; inspect ${project.stateDir}`);
      project.question = project.store.all('inbox').find(item => item.status === 'open');
    }
    return projects.every(project => project.question);
  }, 'both projects to reach their decision');
  const visible = await consoleRequest('/api/projects');
  assert.equal(visible.length, 2);
  for (const project of projects) {
    const view = visible.find(item => item.projectId === project.identity.projectId);
    assert.equal(view?.status, 'available');
    assert.equal(view.snapshot.tasks[0].id, 'feature-1');
    assert.equal(view.snapshot.flows[0].id, 'flow-1');
    assert.equal(view.snapshot.inbox.filter(item => item.status === 'open').length, 1);
  }
  if (serve) {
    // Optional synthetic console data; see evals/ui-demo.mjs for what is real and what is illustrative.
    const demo = uiDemo ? await (await import('./ui-demo.mjs')).seedUiDemo({ projects, consoleInstance, consoleRequest, until, runtime }) : null;
    if (demo) cleanups.push(demo.close);
    console.log(JSON.stringify({ synthetic: true, mode: uiDemo ? 'interactive-ui-demo' : 'interactive-rehearsal', ...(demo ? { demoProjects: demo.projects, demoNote: 'Lifecycle records are real rehearsal runtime records; findings, plan cache, notifications, obligations, the regression report and main-health checks are labelled illustrative.' } : {}), supervisor, url: consoleInstance.url, runtimeDir: runtime, projects: projects.map(project => ({ projectId: project.identity.projectId, name: project.scenario.id, root: project.root, stateDir: project.stateDir })), note: uiDemo ? 'The second project keeps an open decision; the lossy demo endpoint holds one unresolved receipt. Ctrl+C closes services and retains runtime files.' : 'Both decisions await operator answers in the console. Ctrl+C closes services and retains runtime files.' }, null, 2));
    await new Promise(resolve => {
      const finish = () => { interrupted = true; process.removeListener('SIGINT', finish); process.removeListener('SIGTERM', finish); resolve(); };
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
    });
  } else {
    for (const project of projects) {
      const question = project.question;
      const result = await consoleRequest('/api/commands', { projectId: project.identity.projectId, bindingId: project.binding.bindingId, commandId: randomUUID(), operation: 'answer', payload: { inboxId: question.id, version: question.version, subjectDigest: question.subjectDigest, answer: 'continue' }, actor: 'operator' });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      await until(() => project.store.need('flow', 'flow-1').state === 'completed', `${project.scenario.id} completion`);
      const after = command(project.scenario.check.argv, project.root);
      assert.equal(after.exitCode, 0);
      for (const other of projects.filter(item => item !== project && !item.completed)) {
        assert.equal(other.store.need('inbox', other.question.id).status, 'open', 'answer must remain scoped to one project');
      }
      project.completed = true;
    }
    console.log(JSON.stringify({ synthetic: true, mode: 'deterministic-rehearsal', passed: true, supervisor, projects: projects.map(project => ({ scenario: project.scenario.id, projectId: project.identity.projectId, taskId: 'feature-1', flowId: 'flow-1', baselinePassed: true, featureFailedBeforeBuild: true, unapprovedLaunchRejected: true, completed: true, acceptancePassed: true, ...(flags.has('--keep') ? { root: project.root, stateDir: project.stateDir, evidenceDir: join(project.stateDir, 'attempts') } : {}) })), sharedConsole: true, ...(flags.has('--keep') ? { runtimeDir: runtime } : {}), limitations: ['Trusted synthetic patch workers; no real agent implementation or independent code review.', 'No GitHub integration or merge was exercised.', supervisor === 'process' ? 'Process supervisor only; systemd service containment requires --systemd.' : 'systemd user transient units exercised on this host only.'] }, null, 2));
  }
} catch (error) {
  // Detached supervisors may still need their intents and receipt directories.
  // Preserve uncertain/live effects instead of deleting their recovery evidence.
  const unresolved = projects.some(project => project.store.all('attempt').some(attempt => !attempt.settledAt));
  preserveRuntime ||= unresolved;
  console.error(JSON.stringify({ synthetic: true, passed: false, error: error.message, ...(preserveRuntime ? { runtimeDir: runtime } : {}), ...(unresolved ? { note: 'Unsettled effects remain; runtime files were retained for reconciliation.' } : {}) }, null, 2));
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups) await cleanup();
  if (consoleInstance) await consoleInstance.close();
  for (const project of projects.reverse()) {
    if (project.service) await project.service.close();
    project.store.close();
  }
  if (!preserveRuntime) await rm(runtime, { recursive: true, force: true });
}
