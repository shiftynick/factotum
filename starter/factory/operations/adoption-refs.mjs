import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from '../adapters/workspace/index.mjs';
import { clearTickProblem, recordTickProblem } from './tick-problems.mjs';
import { now } from '../core/contracts.mjs';
import { ADOPTION_REFS_KIND, ADOPTION_REF } from '../core/adoption-ref-names.mjs';

// The private refs adopted pull requests' `candidate` attempts fetch into the project checkout.
// Each attempt fetches into names of its own (core/adoption-ref-names.mjs). The engine records an
// attempt's names in the flow's pending-refs record (one KIND record per flow) when it prepares
// the attempt, before anything is fetched, and settlement adds the OIDs they were set to. Once the
// flow has ended and its workspace, if it had one, was released (cleanup or preservation), the
// operations loop deletes the recorded names of that flow, each only while it points at the
// recorded OID (`git update-ref -d <ref> <oid>`; for a name recorded without an OID, a crashed
// attempt's, at the OID just read), so a ref that moved is never removed.
//
// Safety does not depend on timing: every name the sweep deletes belongs to an attempt that had
// ended when the sweep read the record, and no later attempt uses that name. A flow reactivated
// while a sweep runs (flow.replan) fetches into new names, which a sweep started earlier never
// read; its final transaction removes from the record only the names it handled.
//
// The sweep never holds up the operations tick, and its work per tick is bounded:
// - each tick looks at no more than BATCH records, read by key after a cursor kept in meta, so
//   10,000 waiting flows cost BATCH flow reads per tick, not 10,000;
// - every Git call is killed after GIT_TIMEOUT_MS (a FIFO or a hung filesystem at a ref path
//   cannot hold it), and no new call starts after SWEEP_DEADLINE_MS;
// - the tick waits for a sweep at most TICK_BUDGET_MS; a slower sweep finishes in the
//   background and the next tick does not start another while it runs;
// - all of a sweep's changes, with the cursor, are written in one transaction at its end.
export const KIND = ADOPTION_REFS_KIND;
export { ADOPTION_REF };
export const BATCH = 16, GIT_TIMEOUT_MS = 2000, SWEEP_DEADLINE_MS = 5000, TICK_BUDGET_MS = 250;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CURSOR = 'adoptionRefsCursor';

// In a transaction (attempt preparation, with oid null; settlement, with the OIDs). Names recorded
// earlier for the flow are kept; a name recorded again takes the new OID, never losing one to null.
export function recordAdoptionRefs(store, flowId, refs) {
  const rows = (Array.isArray(refs) ? refs : []).filter(row => ADOPTION_REF.test(row?.ref ?? '') && (row.oid === null || OID.test(row?.oid ?? ''))).map(({ ref, oid }) => ({ ref, oid }));
  if (!rows.length) return;
  const existing = store.get(KIND, flowId), earlier = existing?.refs ?? [], byName = new Map(earlier.map(row => [row.ref, row]));
  for (const row of rows) byName.set(row.ref, row.oid === null && byName.get(row.ref)?.oid ? byName.get(row.ref) : row);
  store.put(KIND, { ...(existing ?? {}), id: flowId, flowId, refs: [...byName.values()], recordedAt: now() });
}

// Ended, and nothing of it is still kept by an unreleased workspace.
export function adoptionRefsReleasable(flow) {
  if (!flow || !['completed', 'failed'].includes(flow.state)) return false;
  if (!flow.workspace || flow.workspaceReleased) return true;
  return flow.state === 'completed' && !flow.cleanupPending;
}

// One ref: 'removed' (deleted at its OID, or already absent), 'moved' (points elsewhere; kept for
// good) or 'error' (could not be read or deleted, or timed out; retried by a later sweep).
// Absence is told from a read failure with for-each-ref: an absent ref lists nothing and says
// nothing, while a broken or unreadable one lists nothing but warns ("ignoring broken ref").
// (show-ref --verify --quiet exits 1 in both cases, so it cannot tell them apart.) for-each-ref
// skips a non-regular file at the loose ref's path without a word, so "nothing listed" counts as
// absent only when nothing at all is at that path.
async function releaseRef(run, root, commonDir, { ref, oid }) {
  const read = await run(root, ['for-each-ref', '--format=%(objectname)', ref], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS });
  if (read.timedOut || read.code !== 0 || String(read.stderr ?? '').trim()) return { ref, oid, status: 'error', error: read.timedOut ? `reading the ref timed out after ${GIT_TIMEOUT_MS} ms` : String(read.stderr ?? '').trim().slice(0, 300) || `exit ${read.code}` };
  const found = read.stdout.trim();
  if (!found) {
    try { await lstat(join(commonDir, ref)); return { ref, oid, status: 'error', error: `Git does not read ${join(commonDir, ref)} as a ref, but something is there; inspect it` }; }
    catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { ref, oid, status: 'removed', absent: true } : { ref, oid, status: 'error', error: `cannot inspect ${join(commonDir, ref)} (${error.code ?? error.message})` }; }
  }
  // A name recorded without an OID (its attempt never settled) is deleted at the OID just read:
  // the name is that ended attempt's own, so nothing else writes it.
  if (oid !== null && found !== oid) return { ref, oid, status: 'moved', found };
  const deleted = await run(root, ['update-ref', '-d', ref, found], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS });
  return deleted.code === 0 ? { ref, oid, status: 'removed' } : { ref, oid, status: 'error', error: deleted.timedOut ? `deleting the ref timed out after ${GIT_TIMEOUT_MS} ms` : String(deleted.stderr ?? '').trim().slice(0, 300) || `exit ${deleted.code}` };
}

// One bounded pass over the next BATCH records after the cursor.
export async function releaseAdoptionRefs(store, { root = store.meta('project')?.root, run = git, batch = BATCH, deadlineMs = SWEEP_DEADLINE_MS } = {}) {
  const end = Date.now() + deadlineMs, results = [], cursor = store.meta(CURSOR, '');
  const rows = store.db.prepare('SELECT id, data FROM records WHERE kind=? AND id>? ORDER BY id LIMIT ?').all(KIND, cursor, batch).map(row => ({ id: row.id, ...JSON.parse(row.data) }));
  let next = rows.length < batch ? '' : rows.at(-1).id, commonDir = null, commonError = null; // a short page wraps to the start
  for (const [index, row] of rows.entries()) {
    if (Date.now() >= end) { next = index ? rows[index - 1].id : cursor; break; } // resume at this row next time
    // Only an ended flow's names, as read now: all of them belong to attempts that have ended.
    const flow = store.get('flow', row.id);
    if (flow && !adoptionRefsReleasable(flow)) continue;
    if (!commonDir && !commonError) {
      const common = await run(root, ['rev-parse', '--git-common-dir'], { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS });
      if (common.code === 0 && common.stdout.trim()) commonDir = resolve(root, common.stdout.trim()); else commonError = common.timedOut ? `finding the Git directory timed out after ${GIT_TIMEOUT_MS} ms` : String(common.stderr ?? '').trim().slice(0, 300) || `exit ${common.code}`;
    }
    const refs = [];
    for (const entry of row.refs) refs.push(commonError ? { ...entry, status: 'error', error: commonError } : Date.now() < end ? await releaseRef(run, root, commonDir, entry) : { ...entry, status: 'error', error: 'sweep deadline reached' });
    results.push({ flowId: row.id, refs });
  }
  store.tx(() => {
    for (const { flowId, refs } of results) {
      const current = store.get(KIND, flowId);
      if (!current) continue;
      // Remove exactly the names handled here (as they were read); keep anything recorded since.
      const handled = new Map(refs.map(row => [row.ref, row])), remaining = [], retried = [];
      for (const entry of current.refs) {
        const row = handled.get(entry.ref);
        if (!row || row.oid !== entry.oid) remaining.push(entry);
        else if (row.status === 'error') { remaining.push(entry); retried.push(row); }
      }
      if (remaining.length) store.put(KIND, { ...current, refs: remaining, ...(retried.length ? { attempts: (current.attempts ?? 0) + 1, lastError: retried.map(row => `${row.ref}: ${row.error}`).join('; ').slice(0, 600), lastTriedAt: now() } : {}) });
      else store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(KIND, flowId);
      const done = refs.filter(row => row.status !== 'error'), flow = store.get('flow', flowId);
      if (flow && done.length) {
        const previous = flow.adoptionRefsReleased ?? { removed: [], kept: [] };
        flow.adoptionRefsReleased = { at: now(), removed: [...(previous.removed ?? []), ...done.filter(row => row.status === 'removed').map(row => row.ref)], kept: [...(previous.kept ?? []), ...done.filter(row => row.status === 'moved').map(({ ref, oid, found }) => ({ ref, oid, found }))] };
        store.put('flow', flow);
      }
      if (done.length) store.event('adoption.refs-released', { flowId, removed: done.filter(row => row.status === 'removed').map(row => row.ref), kept: done.filter(row => row.status === 'moved').map(row => row.ref), retry: retried.map(row => ({ ref: row.ref, error: row.error })) });
    }
    if (next !== cursor) store.setMeta(CURSOR, next);
  });
  return results.map(({ flowId, refs }) => ({ flowId, removed: refs.filter(row => row.status === 'removed'), kept: refs.filter(row => row.status === 'moved'), retry: refs.filter(row => row.status === 'error') }));
}

// For the operations tick: start a sweep unless one is still running, and wait for it at most
// budgetMs. A sweep that takes longer finishes in the background; its failure is recorded, never thrown.
const running = new WeakMap();
// The sweep still running for this store, if any (tests and shutdown wait for it).
export const runningSweep = store => running.get(store) ?? null;
export async function sweepAdoptionRefs(store, { budgetMs = TICK_BUDGET_MS, ...options } = {}) {
  if (running.has(store)) return { running: true };
  const sweep = releaseAdoptionRefs(store, options)
    // A sweep that fails the same way on every tick is recorded once (dev.91, O5).
    .then(result => { try { clearTickProblem(store, 'adoption-refs'); } catch { /* store closed meanwhile */ } return result; },
      error => { try { recordTickProblem(store, 'adoption-refs', 'adoption.refs-release-failed', String(error?.message ?? error).slice(0, 300)); } catch { /* store closed meanwhile */ } return { failed: true }; })
    .finally(() => running.delete(store));
  running.set(store, sweep);
  let timer;
  const result = await Promise.race([sweep, new Promise(resolve => { timer = setTimeout(() => resolve({ running: true }), budgetMs); timer.unref?.(); })]);
  clearTimeout(timer);
  return result;
}
