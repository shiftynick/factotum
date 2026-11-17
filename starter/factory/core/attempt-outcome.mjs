// The routed outcome of a settled attempt, recorded beside its lifecycle status.
//
// An attempt's status says whether its effect ran and settled cleanly (passed, failed, aborted,
// uncertain, not-dispatched). A clean run can still report a product failure through its result's
// route: a fast check or gate check that failed, a red main verification, a scheduled task that
// exited non-zero. The engine routes such a result as the graph says (a failed fast check returns
// the work to the builder; it does not fail the flow), so the status stays passed and every
// lifecycle rule that reads it is unchanged. The failure is carried by a separate field:
//
//   outcome: 'failed'                       the step's own result was a failure (route fail)
//   failedChecks: [{id, status, failureClass?, exitCode?}]   the checks that did not pass
//   outcome: 'turn-limit'                   the step's provider stopped at its turn limit and the
//                                            step did not finish (a builder out of turns: its result
//                                            is routed blocked to the build question, dev.85 I2)
//
// Attempts settled before this field existed are projected the same way from their receipt.
const MAX_CHECKS = 16;
export function attemptOutcome(status, result) {
  if (status !== 'passed' || !result || typeof result !== 'object') return null;
  if (result.turnLimit && typeof result.turnLimit === 'object' && !Array.isArray(result.turnLimit)) return { outcome: 'turn-limit' };
  if (result.route !== 'fail') return null;
  // A main verification keeps its check rows in mainHealth.checks.
  const rows = Array.isArray(result.checks) ? result.checks : Array.isArray(result.mainHealth?.checks) ? result.mainHealth.checks : null;
  const failedChecks = rows ? rows.filter(check => check && typeof check === 'object' && check.status !== 'passed').slice(0, MAX_CHECKS).map(check => ({
    id: String(check.id ?? ''), status: String(check.status ?? 'failed'),
    ...(typeof check.failureClass === 'string' ? { failureClass: check.failureClass } : {}),
    ...(Number.isInteger(check.exitCode) ? { exitCode: check.exitCode } : {}),
  })) : [];
  return { outcome: 'failed', ...(failedChecks.length ? { failedChecks } : {}) };
}
