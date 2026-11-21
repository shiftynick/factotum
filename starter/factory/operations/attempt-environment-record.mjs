// The attempt-environment check the running project service records (dev.105): whether an
// attempt unit resolves the same `node` and `git` as the service, which the service checks with
// its own environment at start and after a configuration change
// (operations/attempt-environment-probe.mjs). One meta row, `attemptEnvironmentCheck`, holds the
// latest result: status (same, differs, unverified or not-applicable), the paths each side
// resolves, when it was checked, the executor digest of the service code it was checked under,
// the configuration digest and what started it. Doctor, status, queue status, admission and the
// console read it; nothing else probes.
//
// A `differs` result holds admission of new task flows (the same way a doctor reason holds it,
// through the commissioning hold) until a later check records `same`: an attempt with another
// node or git produces false check results (dev.104: main.verify went falsely red) and builders
// run a toolchain the project did not choose. Running flows are not stopped.
export const ATTEMPT_ENVIRONMENT_META = 'attemptEnvironmentCheck';
const STATUSES = new Set(['same', 'differs', 'unverified', 'not-applicable']);
const text = value => typeof value === 'string' ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : [];
const command = entry => entry && typeof entry === 'object' ? { path: text(entry.path), realPath: text(entry.realPath) } : null;
const commands = side => side && typeof side === 'object' ? { node: command(side.node), git: command(side.git) } : null;

export const attemptEnvironmentCheck = store => store.meta(ATTEMPT_ENVIRONMENT_META, null) ?? null;

export function recordAttemptEnvironmentCheck(store, result) {
  const status = STATUSES.has(result.status) ? result.status : 'unverified';
  const record = {
    status, checkedAt: result.checkedAt, startedAt: result.startedAt ?? null, trigger: result.trigger ?? null,
    executorDigest: result.executorDigest ?? null, configDigest: result.configDigest ?? null, supervisor: result.supervisor ?? null,
    ...(result.pathFrom ? { pathFrom: result.pathFrom } : {}), ...(result.reason ? { reason: String(result.reason).slice(0, 500) } : {}),
    ...(result.service ? { service: commands(result.service) } : {}), ...(result.attempt ? { attempt: commands(result.attempt) } : {}), ...(result.manager ? { manager: commands(result.manager) } : {}),
    reasons: strings(result.reasons), warnings: strings(result.warnings),
  };
  store.tx(() => {
    const previous = attemptEnvironmentCheck(store);
    store.setMeta(ATTEMPT_ENVIRONMENT_META, record);
    store.event('attempt-environment.checked', { status, trigger: record.trigger, ...(previous && previous.status !== status ? { previous: previous.status } : {}), ...(record.reasons.length ? { reasons: record.reasons } : {}) });
  });
  return record;
}

// The admission hold text while the latest result is `differs`, otherwise null.
export function attemptEnvironmentHold(store, record = attemptEnvironmentCheck(store)) {
  if (record?.status !== 'differs') return null;
  return `attempt units resolve a different node or git than the project service (checked at ${record.checkedAt}): ${record.reasons[0] ?? 'see status health.attemptEnvironment'}`;
}

// What status and the console show (health.attemptEnvironment): the latest result, bounded, or null.
export function attemptEnvironmentView(store) {
  const record = attemptEnvironmentCheck(store);
  if (!record) return null;
  return { status: record.status, checkedAt: record.checkedAt ?? null, trigger: record.trigger ?? null, holdsAdmission: record.status === 'differs', ...(record.reason ? { reason: record.reason } : {}),
    ...(record.service ? { service: record.service } : {}), ...(record.attempt ? { attempt: record.attempt } : {}), reasons: record.reasons ?? [], warnings: record.warnings ?? [] };
}

// Doctor reads the recorded result; it starts no unit itself. A result recorded under other
// service code (an upgrade, while the service is stopped) or none at all is unverified, a
// warning: the service checks it when it next starts. Under the same code, `differs` is a
// blocking reason and `unverified` the warnings the service recorded.
export const NOT_YET_CHECKED = 'Not yet verified that attempt units run the project service\'s node and git: the project service has not checked this release yet. It checks when it next starts, in the background, and again after a configuration change; status (health.attemptEnvironment) and the console show the result, and a difference holds admission until a later check finds none';
export function recordedAttemptEnvironment({ store, executor }) {
  const record = attemptEnvironmentCheck(store), reasons = [], warnings = [];
  if (!record || record.executorDigest !== executor) {
    warnings.push(NOT_YET_CHECKED);
    return { reasons, warnings, record: { status: 'unverified', reason: 'not checked by the project service under this release', ...(record ? { previous: { status: record.status, checkedAt: record.checkedAt ?? null } } : {}) } };
  }
  if (record.status === 'differs') reasons.push(...record.reasons);
  if (record.status === 'unverified') warnings.push(...(record.warnings.length ? record.warnings : [`Not verified that attempt units run the project service's node and git: ${record.reason ?? 'the service\'s check did not finish'}`]));
  else warnings.push(...record.warnings);
  const { reasons: _reasons, warnings: _warnings, ...shown } = record;
  return { reasons, warnings, record: shown };
}
