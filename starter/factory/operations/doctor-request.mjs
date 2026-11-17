import { now } from '../core/contracts.mjs';

// A console-requested doctor run. The operations loop starts it without waiting, so other
// work keeps moving; doctor itself requires a drained project, as from the CLI. One runs at
// a time per project; the outcome is recorded on the request.
const running = new Map();
export function runDoctorRequest(store, { doctor } = {}) {
  const request = store.meta('doctorRequest');
  if (request?.status !== 'queued' || running.has(store.stateDir)) return null;
  store.tx(() => store.setMeta('doctorRequest', { ...request, status: 'running', startedAt: now() }));
  const task = (async () => {
    let result;
    // While doctor waits for the shared heavy permit, the request shows who holds it.
    const onResourceWait = wait => store.tx(() => { const current = store.meta('doctorRequest'); if (current?.id !== request.id || current.status !== 'running') return; const { waitingFor, ...rest } = current; store.setMeta('doctorRequest', wait ? { ...rest, waitingFor: wait } : rest); });
    try { result = await (doctor ?? (await import('../workflows/commission.mjs')).doctor)(store.stateDir, { onResourceWait }); }
    catch (error) { result = { ready: false, reasons: [error.message] }; }
    store.tx(() => {
      const current = store.meta('doctorRequest');
      if (current?.id !== request.id) return;
      const { waitingFor, ...settled } = current;
      store.setMeta('doctorRequest', { ...settled, status: result.ready ? 'passed' : 'failed', finishedAt: now(), ready: Boolean(result.ready), reasons: (result.reasons ?? []).slice(0, 20).map(String) });
      store.event('doctor.finished', { id: request.id, ready: Boolean(result.ready) });
    });
    return result;
  })().finally(() => running.delete(store.stateDir));
  running.set(store.stateDir, task);
  return task;
}
