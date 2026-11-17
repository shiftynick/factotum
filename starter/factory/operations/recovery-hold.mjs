// Recovery hold: admission and dispatch stop until the operator reconciles every unsettled
// attempt and releases it with restore.release. It is reserved for state whose integrity is in
// doubt: a restored backup, a runner (engine) fault, or a database fault in the operations loop.
// Every hold records why (meta recoveryHoldReason), so a stopped flow says what happened.
const CAUSES = {
  restore: 'this state was restored from a backup',
  'runner-fault': 'the flow runner faulted',
  'operations-fault': 'the operations loop hit a state-integrity fault',
};
export function placeRecoveryHold(store, { cause, error }) {
  store.setMeta('recoveryHold', true);
  store.setMeta('recoveryHoldReason', { cause, ...(error ? { error: String(error).slice(0, 500) } : {}), at: new Date().toISOString() });
}
export function clearRecoveryHold(store) { store.setMeta('recoveryHold', false); store.setMeta('recoveryHoldReason', null); }
export const recoveryHoldReason = store => store.meta('recoveryHold') ? store.meta('recoveryHoldReason', null) ?? null : null;
// The text a stopped flow and a refused admission carry.
export function recoveryHoldMessage(store) {
  const reason = store.meta('recoveryHoldReason', null);
  const what = reason ? `${CAUSES[reason.cause] ?? reason.cause}${reason.error ? ` (${reason.error})` : ''}` : 'cause not recorded (set by a restore or a fault before this release)';
  return `recovery hold: ${what}; reconcile unsettled attempts, stop active flows and release it with restore.release`;
}

// Faults in the operations loop. Only a database fault that leaves the state's integrity in
// doubt (I/O error, corruption, full disk, read-only or unopenable database) places a recovery
// hold. Anything else (a failing optional integration, a scheduled operation that cannot be
// dispatched, a programming error) is recorded once as a visible health problem
// (meta operationsFault, event operations.fault) and cleared by the next tick that succeeds; the
// loop keeps running and work is not stopped. A failed transaction is rolled back, so it leaves
// no partial state.
const INTEGRITY_SQLITE_CODES = new Set([8, 10, 11, 13, 14, 26]); // READONLY, IOERR, CORRUPT, FULL, CANTOPEN, NOTADB
export function threatensStateIntegrity(error) {
  if (error?.integrity === true) return true;
  return Number.isInteger(error?.errcode) && INTEGRITY_SQLITE_CODES.has(error.errcode & 0xff);
}
export function recordOperationsFault(store, error) {
  const message = String(error?.message ?? error).slice(0, 500);
  if (threatensStateIntegrity(error)) {
    store.tx(() => {
      if (!store.meta('recoveryHold')) placeRecoveryHold(store, { cause: 'operations-fault', error: message });
      store.event('operations.fault', { error: message, recoveryHold: true });
    });
    return;
  }
  store.tx(() => {
    const prior = store.meta('operationsFault', null);
    if (prior?.error === message) return;
    store.setMeta('operationsFault', { error: message, since: prior?.since ?? new Date().toISOString(), changedAt: new Date().toISOString() });
    store.event('operations.fault', { error: message, recoveryHold: false });
  });
}
export function clearOperationsFault(store) {
  const prior = store.meta('operationsFault', null); if (!prior) return;
  store.tx(() => { store.setMeta('operationsFault', null); store.event('operations.recovered', { error: prior.error, since: prior.since }); });
}
