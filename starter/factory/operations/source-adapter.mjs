import { assert, digest } from '../core/contracts.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { sourceSettings } from './source-config.mjs';
import { validNotBefore } from './not-before.mjs';
import { validateOriginalRequest } from './original-request.mjs';

// The issue source contract. Every source reads (see source-sync.mjs). Writes are
// optional, declared capabilities:
//   create     make a new task in the source from a brief
//   lifecycle  record progress (admitted, review, completed, stopped) on a source task
//   close      close a source task after proven delivery
// GitHub implements all three on top of the forge adapter. A command source
// declares the ones its script supports in sourceSync.capabilities.
export const SOURCE_CAPABILITIES = Object.freeze(['create', 'lifecycle', 'close']);
export function sourceCapabilities(config) {
  const s = sourceSettings(config);
  if (s.type === 'github') return { type: 'github', create: s.create !== false, lifecycle: Boolean(config.repository?.issueProfile?.lifecycle), close: config.repository?.closeTasks === true };
  const declared = new Set(s.capabilities ?? []);
  return { type: 'command', create: declared.has('create'), lifecycle: declared.has('lifecycle'), close: declared.has('close') };
}
export const lifecycleEnabled = config => config?.mode === 'delivery' ? sourceCapabilities(config).lifecycle : Boolean(config?.repository?.issueProfile?.lifecycle);

// One write through a command source. Each write carries a stable operationId. The
// script must apply it at most once and answer `lookup` for it, so an uncertain
// outcome is resolved by asking rather than by writing again.
export async function commandSourceWrite(config, root, { operation, operationId, payload }, { run = runProcess, signal } = {}) {
  const s = sourceSettings(config), capabilities = sourceCapabilities(config);
  assert(s.type === 'command' && capabilities[operation], `the command source does not declare the ${operation} capability`);
  assert(typeof operationId === 'string' && operationId, 'operationId required');
  const call = async (op, extra) => {
    const result = await run(s.argv[0], s.argv.slice(1), { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, input: JSON.stringify({ version: 1, operation: op, sourceId: s.id, operationId, ...extra }), timeoutMs: s.timeoutMs, signal });
    if (result.code !== 0) return null;
    const response = JSON.parse(result.stdout);
    assert(response.version === 1 && response.operationId === operationId && ['applied', 'absent', 'rejected'].includes(response.status), `invalid ${op} response from the command source`);
    return response;
  };
  const before = await call('lookup', { lookup: operation });
  if (before?.status === 'applied') return { ...before.result, operationId, reconciled: true };
  const response = await call(operation, payload);
  if (response?.status === 'applied') return { ...response.result, operationId };
  if (response?.status === 'rejected') throw Object.assign(new Error(`command source rejected ${operation}: ${String(response.reason ?? 'no reason given').slice(0, 300)}`), { ambiguous: false });
  // Failed or unreadable: ask whether it happened before reporting.
  const after = await call('lookup', { lookup: operation });
  if (after?.status === 'applied') return { ...after.result, operationId, reconciled: true };
  if (after?.status === 'absent') throw Object.assign(new Error(`command source did not apply ${operation}`), { ambiguous: false });
  throw Object.assign(new Error(`command source ${operation} outcome is uncertain; reconcile before retrying`), { ambiguous: true });
}

// A normalized brief for creating a task in a source.
export function validateCreateBrief(brief) {
  assert(brief && typeof brief.title === 'string' && brief.title.trim() && brief.title.length <= 256, 'a task title is required');
  assert(Array.isArray(brief.acceptance) && brief.acceptance.length && brief.acceptance.every(x => typeof x === 'string' && x.trim()), 'acceptance criteria are required');
  for (const key of ['paths', 'labels']) assert(brief[key] === undefined || Array.isArray(brief[key]) && brief[key].every(x => typeof x === 'string' && x.trim()), `invalid ${key}`);
  assert(brief.risk === undefined || ['ordinary', 'strict'].includes(brief.risk), 'invalid risk');
  assert(brief.category === undefined || typeof brief.category === 'string' && brief.category.trim(), 'invalid category');
  assert(brief.workflow === undefined || typeof brief.workflow === 'string' && brief.workflow.trim(), 'invalid workflow');
  validNotBefore(brief.notBefore ?? null);
  validateOriginalRequest(brief.originalRequest);
  return { title: brief.title.trim(), acceptance: brief.acceptance.map(x => x.trim()), ...(brief.paths?.length ? { paths: brief.paths } : {}), ...(brief.labels?.length ? { labels: [...new Set(brief.labels.map(x => x.trim()))] } : {}), ...(brief.risk ? { risk: brief.risk } : {}), ...(brief.category ? { category: brief.category.trim() } : {}), ...(brief.workflow ? { workflow: brief.workflow.trim() } : {}), ...(brief.notBefore ? { notBefore: brief.notBefore } : {}), ...(brief.originalRequest ? { originalRequest: brief.originalRequest } : {}) };
}
export const createOperationId = (projectId, jobId, brief) => `${projectId}:source.create:${jobId}:${digest(brief).slice(0, 16)}`;
