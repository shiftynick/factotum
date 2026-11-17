import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../starter/factory/core/store.mjs';
import { runRelease, runEvaluation } from '../starter/factory/operations/extensions.mjs';
import { createLocalDeployment } from '../examples/release-lab/deployment.mjs';
import { addTask, completeTask } from '../examples/web-app/src/tasks.js';
import { execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'factotum-extension-eval-')), store = new Store(join(root, 'state'), { create: true });
try {
  const adapter = createLocalDeployment(join(root, 'deployment')), authorize = async ({ candidateDigest }) => ({ approved: true, candidateDigest });
  const healthy = await runRelease(store, { id: 'healthy', candidate: { version: 'v1' }, authorize, ...adapter });
  const broken = await runRelease(store, { id: 'migration-failure', candidate: { version: 'v2', behavior: 'broken-migration' }, authorize, ...adapter });
  if (healthy.status !== 'passed' || broken.status !== 'stopped' || !broken.after) throw new Error('release qualification failed');
  const evaluation = await runEvaluation(store, { id: 'two-stack-journeys', promises: [{ id: 'web', description: 'Web module adds and completes a fictional task' }, { id: 'python', description: 'Python CLI reports usage successfully' }], observe: async promise => {
    if (promise.id === 'web') { const tasks = completeTask(addTask([], 'Fictional journey'), 1); return { status: tasks[0].completed ? 'passed' : 'failed', evidence: tasks }; }
    const output = execFileSync('python3', [new URL('../examples/python-cli/tasklist.py', import.meta.url).pathname, '--help'], { encoding: 'utf8', timeout: 5000 }); return { status: output.includes('usage:') ? 'passed' : 'failed', evidence: { output } };
  } });
  if (evaluation.judgments[0].value.outcomes.some(o => o.status !== 'passed')) throw new Error('journey qualification failed');
  console.log(JSON.stringify({ synthetic: true, release: healthy.status, unsafeMigration: broken.status, journeys: evaluation.judgments[0].value.outcomes.map(o => ({ id: o.promiseId, status: o.status })) }, null, 2));
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
