import { processIdentity, sameProcess } from '../core/process-identity.mjs';

// The attempt-environment check the running project service records (dev.105): whether an
// attempt unit resolves the same `node` and `git` as the service, which the service checks with
// its own environment at start and after a configuration change
// (operations/attempt-environment-probe.mjs).
//
// Two meta rows. `attemptEnvironmentRun` is the service run that checks: its id, when it started,
// its process identity, until when its start check may still be pending, and when it stopped.
// `attemptEnvironmentCheck` is the latest result: status (same, differs, unverified or
// not-applicable), the paths each side resolves, when it was checked, the service run it belongs
// to, the executor digest of the service code and the configuration digest.
//
// A result is current only while the service run that recorded it is still running (same id, not
// stopped, the same live process). Anything else is evidence from an earlier run: stale, never a
// current `same` and never blocking. So doctor, which normally runs with the service stopped (CLI,
// upgrade apply, recovery), never refuses for it; a difference blocks only through the running
// service's own admission hold.
//
// The hold (attemptEnvironmentHold) applies while the current result is `differs`, and while the
// current run's start check is pending, up to the probe's own deadline. It holds new task flows and
// new maintenance that runs the project's tools (environmentFreeOperation says which do not).
// Running flows are not stopped. A check that fails or times out records `unverified`, which holds
// nothing.
export const ATTEMPT_ENVIRONMENT_META = 'attemptEnvironmentCheck';
export const ATTEMPT_ENVIRONMENT_RUN_META = 'attemptEnvironmentRun';
const STATUSES = new Set(['same', 'differs', 'unverified', 'not-applicable']);
const text = value => typeof value === 'string' ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : [];
const command = entry => entry && typeof entry === 'object' ? { path: text(entry.path), realPath: text(entry.realPath) } : null;
const commands = side => side && typeof side === 'object' ? { node: command(side.node), git: command(side.git) } : null;

// Maintenance that starts no project tool (no node, git or check from PATH): a backup and an
// archive copy the project's own state, a machine sample reads the host, and a queue dispatch
// admits task flows through admission, which applies the hold itself.
const ENVIRONMENT_FREE = new Set(['maintenance.backup', 'retention.archive', 'machine.sample', 'queue.dispatch']);
export const environmentFreeOperation = operation => ENVIRONMENT_FREE.has(operation);

export const attemptEnvironmentCheck = store => store.meta(ATTEMPT_ENVIRONMENT_META, null) ?? null;

let own = null;
const ownIdentity = () => { try { return own ??= processIdentity(); } catch { return { pid: process.pid }; } };
const sameIdentity = (a, b) => a?.pid === b?.pid && a?.bootId === b?.bootId && a?.startTime === b?.startTime;
// The service run, while it is running: not stopped, and its process alive (this one, or another
// with the same identity). A service that crashed leaves a run whose process is gone.
export function liveAttemptEnvironmentRun(store, run = store.meta(ATTEMPT_ENVIRONMENT_RUN_META, null)) {
  if (!run || run.stoppedAt || !run.owner) return null;
  return (run.owner.pid === process.pid ? sameIdentity(run.owner, ownIdentity()) : sameProcess(run.owner)) ? run : null;
}
// The service records its run when it starts; pendingUntil is null where nothing is probed.
export function beginAttemptEnvironmentRun(store, { id, startedAt = new Date().toISOString(), pendingUntil = null, supervisor = null }) {
  const run = { id, startedAt, owner: ownIdentity(), supervisor, pendingUntil };
  store.tx(() => store.setMeta(ATTEMPT_ENVIRONMENT_RUN_META, run));
  return run;
}
export function endAttemptEnvironmentRun(store, id) {
  store.tx(() => { const run = store.meta(ATTEMPT_ENVIRONMENT_RUN_META, null); if (run?.id === id && !run.stoppedAt) store.setMeta(ATTEMPT_ENVIRONMENT_RUN_META, { ...run, stoppedAt: new Date().toISOString() }); });
}

export function recordAttemptEnvironmentCheck(store, result) {
  const status = STATUSES.has(result.status) ? result.status : 'unverified';
  const record = {
    status, checkedAt: result.checkedAt, startedAt: result.startedAt ?? null, trigger: result.trigger ?? null, serviceRunId: result.serviceRunId ?? null,
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

// What the record means now: current (recorded by the running service run), pending (that run's
// start check has not recorded yet and its deadline has not passed) or stale (from an earlier run).
export function attemptEnvironmentState(store, { nowMs = Date.now() } = {}) {
  const record = attemptEnvironmentCheck(store), run = liveAttemptEnvironmentRun(store);
  const current = Boolean(run && record && record.serviceRunId === run.id);
  const pending = Boolean(run && !current && run.pendingUntil && nowMs < Date.parse(run.pendingUntil));
  return { record, run, current, pending, stale: Boolean(record && !current) };
}

// The hold text, or null.
export function attemptEnvironmentHold(store, state = attemptEnvironmentState(store)) {
  if (state.current && state.record.status === 'differs') return `attempt units resolve a different node or git than the project service (checked at ${state.record.checkedAt}): ${state.record.reasons[0] ?? 'see status health.attemptEnvironment'}`;
  if (state.pending) return `attempt environment check pending: the project service is checking which node and git attempt units run (started ${state.run.startedAt}; held until it records a result, at most until ${state.run.pendingUntil})`;
  return null;
}

// What status and the console show (health.attemptEnvironment), or null. `status` is the
// recorded status only while current; otherwise `pending` or `stale`, with the recorded one in
// `recordedStatus`.
export function attemptEnvironmentView(store) {
  const state = attemptEnvironmentState(store), { record } = state;
  if (!record && !state.pending) return null;
  const hold = attemptEnvironmentHold(store, state);
  return { status: state.current ? record.status : state.pending ? 'pending' : 'stale', current: state.current, holdsAdmission: Boolean(hold), ...(hold ? { hold } : {}),
    ...(state.pending ? { pendingUntil: state.run.pendingUntil } : {}),
    ...(record ? { recordedStatus: record.status, checkedAt: record.checkedAt ?? null, trigger: record.trigger ?? null, ...(record.reason ? { reason: record.reason } : {}),
      ...(record.service ? { service: record.service } : {}), ...(record.attempt ? { attempt: record.attempt } : {}), reasons: record.reasons ?? [], warnings: record.warnings ?? [] } : {}) };
}

// Doctor reads the recorded result; it starts no unit and never refuses for it. A result recorded
// by the running service run is reported as it is (a difference as a warning, since the service's
// admission hold already stops new work); anything else (no result, or one from an earlier service
// run, as during upgrade apply or recovery with the service stopped) is unverified, a warning: the
// service checks when it next starts.
export const NOT_YET_CHECKED = 'Not yet verified that attempt units run the project service\'s node and git: the project service has not checked this since it last started. It checks when it next starts, in the background, and again after a configuration change; status (health.attemptEnvironment) and the console show the result, and a difference holds admission until a later check finds none';
export function recordedAttemptEnvironment({ store }) {
  const state = attemptEnvironmentState(store), { record } = state, reasons = [], warnings = [];
  if (!state.current) {
    warnings.push(record ? `${NOT_YET_CHECKED}. An earlier run of the service recorded ${record.status} at ${record.checkedAt ?? 'an unrecorded time'}` : NOT_YET_CHECKED);
    return { reasons, warnings, record: { status: 'unverified', reason: 'not checked by the running project service', ...(record ? { previous: { status: record.status, checkedAt: record.checkedAt ?? null } } : {}) } };
  }
  if (record.status === 'differs') warnings.push(...record.reasons.map(reason => `${reason} The running project service holds admission until a later check finds no difference.`));
  if (record.status === 'unverified') warnings.push(...(record.warnings.length ? record.warnings : [`Not verified that attempt units run the project service's node and git: ${record.reason ?? 'the service\'s check did not finish'}`]));
  else warnings.push(...record.warnings);
  const { reasons: _reasons, warnings: _warnings, ...shown } = record;
  return { reasons, warnings, record: shown };
}
