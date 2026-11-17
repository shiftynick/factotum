import { targetHealth, defaultTarget } from './targets.mjs';
import { scheduledTierHold, scheduledRedText } from './main-tiers.mjs';
import { timeoutRetryState, timeoutRetryText } from './timeout-retry.mjs';
// How a scheduled-tier red clears for this project, as it is actually configured.
function scheduledRecovery(store, config, auto, target) {
  const manual = 'run main.verify (every tier, the default)';
  const schedule = store.all('schedule').some(row => row.enabled !== false && row.operation === 'main.verify' && (row.payload?.tier ?? 'all') === 'all' && (row.payload?.target ?? defaultTarget(config)) === target);
  const wait = schedule ? ', or wait for the scheduled full verification' : '', name = target === defaultTarget(config) ? 'main' : target;
  if (!auto) return `After fixing ${name}, ${manual}${wait}`;
  if ((config.policy?.mainProbeMs ?? 60000) === 0) return `A full verification is requested automatically after a factory merge moves ${name}; policy.mainProbeMs is 0, so a fix pushed outside the factory is not noticed: ${manual} after it${wait}`;
  return `A full verification is requested automatically once for each new ${name} head, including a fix pushed outside the factory; for the same head (for example after fixing a transient failure), ${manual}${wait}`;
}
// Why a target branch's health blocks admission, in words an operator can act on. The default
// target is called main; another target is named (for example "next health is stale").
function mainHealthReasonText(store, { nowMs = Date.now(), target } = {}) {
  const config = store.meta('config', {}), auto = config.policy?.autoQueue === true, other = target && target !== defaultTarget(config);
  const job = store.live('job').find(row => row.operation === 'main.verify' && ['queued', 'running'].includes(row.status) && (row.payload?.target ?? null) === (other ? target : null));
  if (job) return `main health pending: main verification in progress (job ${job.id}); ${auto ? 'queued tasks are admitted automatically once main is green' : 'start the task again once main is green'}`;
  const health = targetHealth(store, other ? target : null), head = health?.head ? ` at ${String(health.head).slice(0, 12)}` : '';
  const next = auto ? 'a main verification is requested automatically' : 'run main.verify to refresh it';
  if (!health) return `main health unknown: main has never been verified; ${next}`;
  // A red result that failed only on timeouts says where its one automatic re-verification stands.
  const retry = health.status === 'red' ? timeoutRetryText(timeoutRetryState(store, other ? target : defaultTarget(config), { nowMs }), other ? target : 'main') : '';
  if (retry) return `main health is red: ${retry}`;
  const tierHold = scheduledTierHold(config, health, nowMs), full = auto ? 'a full main verification (every tier) is requested automatically' : 'run main.verify (every tier, the default) to refresh it';
  if (tierHold?.kind === 'red') return `main health is red: ${scheduledRedText(tierHold.scheduled)}; fix main or use an explicit recovery task. ${scheduledRecovery(store, config, auto, other ? target : defaultTarget(config))}`;
  if (health.status === 'red') return 'main health is red; fix main or use an explicit recovery task';
  const checked = Date.parse(health.checkedAt ?? health.observedAt), maxAge = config.policy?.mainHealthMaxAgeMs ?? 3600000;
  if (health.status === 'green' && Number.isFinite(checked) && (nowMs - checked > maxAge || checked > nowMs)) return `main health is stale: last verified ${health.checkedAt ?? health.observedAt}${head}, older than policy.mainHealthMaxAgeMs; ${next}`;
  if (health.status === 'green' && tierHold?.kind === 'missing') return `main scheduled-tier checks have not passed yet; ${full}`;
  if (health.status === 'green' && tierHold) return `main scheduled-tier evidence is ${tierHold.scheduled.status === 'green' ? `stale: last verified ${tierHold.scheduled.checkedAt}, older than policy.scheduledHealthMaxAgeMs` : `${tierHold.scheduled.status} from ${tierHold.scheduled.checkedAt}`}; ${full}`;
  return `main health unknown${head}${health.reason ? `: ${health.reason}` : ''}; ${next}`;
}
export function mainHealthReason(store, options = {}) {
  const text = mainHealthReasonText(store, options), config = store.meta('config', {});
  return options.target && options.target !== defaultTarget(config) ? text.replace(/\bmain (health|verification|has never been verified|is green)/g, `${options.target} $1`).replace(/^main /, `${options.target} `) : text;
}
