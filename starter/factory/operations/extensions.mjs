import { assert, digest, now } from '../core/contracts.mjs';
import { processIdentity } from '../core/process-identity.mjs';
import { ownerState } from './resources.mjs';
const locks = new Set();
async function exclusive(store, id, fn) {
  assert(!locks.has(id), 'extension already running');
  const token = digest({ id, at: now(), random: Math.random() });
  store.tx(() => { const old = store.get('extensionLock', id); assert(!old || ownerState(old.owner) === 'dead', 'extension ownership unresolved'); store.put('extensionLock', { id, token, owner: processIdentity() }); });
  locks.add(id);
  try { return await fn(); } finally { locks.delete(id); store.tx(() => { const row = store.get('extensionLock', id); if (row?.token === token) store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('extensionLock', id); }); }
}
function save(store, kind, row, event) { return store.tx(() => { store.put(kind, row); if (event) store.event(event, { id: row.id, status: row.status }); return row; }); }
function evidence(store, row, phase, value) { const entry = { phase, at: now(), value, digest: digest(value) }; row.evidence.push(entry); save(store, 'release', row, 'release.evidence'); return entry; }
function fail(store, row, reason) { row.status = 'stopped'; row.reason = reason; return save(store, 'release', row, 'release.stopped'); }
// Callbacks are trusted project adapters. Only deploy has an external mutation; its persisted intent is never replayed.
export async function runRelease(store, options) { return exclusive(store, `release:${options.id}`, () => release(store, options)); }
async function release(store, { id, candidate, authorize, probe, deploy, lookup, smoke, rollback, capabilities = {} }) {
  assert(id && candidate && typeof probe === 'function' && typeof deploy === 'function' && typeof smoke === 'function', 'release adapter contract incomplete');
  const candidateDigest = digest(candidate); let row = store.get('release', id);
  if (row) assert(row.candidateDigest === candidateDigest, 'release identity reused for a different candidate');
  else row = save(store, 'release', { id, candidate, candidateDigest, status: 'created', evidence: [], createdAt: now() }, 'release.created');
  if (['passed', 'stopped', 'rolled-back'].includes(row.status)) return row;
  if (row.rollbackIntent) return fail(store, row, 'rollback outcome requires explicit reconciliation');
  if (!row.before) {
    try { const before = await probe({ phase: 'before', candidate }); assert(Array.isArray(before.savedItems), 'probe must include savedItems invariants'); row.before = evidence(store, row, 'before', before); }
    catch { return fail(store, row, 'pre-deploy probe unavailable'); }
  }
  if (!row.authorization || !row.intent) {
    assert(typeof authorize === 'function', 'release authorization adapter required');
    const approval = await authorize({ candidate, candidateDigest });
    if (!approval?.approved || approval.candidateDigest !== candidateDigest) return fail(store, row, 'candidate-bound authorization missing');
    row.authorization = { candidateDigest, approvedAt: now(), evidenceDigest: digest(approval) }; save(store, 'release', row, 'release.authorized');
  }
  if (!row.intent) {
    row.intent = { operationId: `release:${id}`, candidateDigest, at: now() }; row.status = 'deploying'; save(store, 'release', row, 'release.deploy-intent');
    try { const result = await deploy({ operationId: row.intent.operationId, candidate }); if (result?.status === 'applied') { row.deployment = result; row.status = 'deployed'; evidence(store, row, 'deployment', result); } else { row.status = 'uncertain'; save(store, 'release', row, 'release.uncertain'); return row; } }
    catch { row.status = 'uncertain'; save(store, 'release', row, 'release.uncertain'); return row; }
  } else if (!row.deployment) {
    if (typeof lookup !== 'function') { row.status = 'uncertain'; return save(store, 'release', row, 'release.uncertain'); }
    let result; try { result = await lookup({ operationId: row.intent.operationId, candidate }); } catch { result = { status: 'unknown' }; }
    if (result?.status !== 'applied') { row.status = 'uncertain'; row.reason = result?.status === 'not-applied' ? 'deployment proved absent; explicit new release required' : 'deployment outcome unknown'; return save(store, 'release', row, 'release.uncertain'); }
    row.deployment = result; row.status = 'deployed'; evidence(store, row, 'deployment-reconciled', result);
  }
  if (!row.after) {
    try { const after = await probe({ phase: 'after', candidate }); assert(Array.isArray(after.savedItems), 'post probe must include savedItems invariants'); row.after = evidence(store, row, 'after', after); }
    catch { return fail(store, row, 'post-deploy probe unavailable'); }
  }
  // Existing saved items must remain byte-equivalent; additional items are permitted.
  const afterItems = row.after.value.savedItems;
  if (!row.before.value.savedItems.every(item => afterItems.some(after => digest(after) === digest(item)))) return fail(store, row, 'saved-item invariants changed');
  let check;
  try { check = await smoke({ candidate, deployment: row.deployment }); assert(typeof check?.passed === 'boolean', 'smoke result requires passed'); evidence(store, row, 'smoke', check); }
  catch { return fail(store, row, 'smoke infrastructure unavailable'); }
  if (!check.passed) {
    if (!rollback) return fail(store, row, 'smoke failed; no rollback requested');
    if (capabilities.rollbackCompatible !== true) return fail(store, row, 'rollback compatibility not proven');
    if (row.rollbackIntent) return fail(store, row, 'rollback outcome requires explicit reconciliation');
    row.rollbackIntent = { operationId: `rollback:${id}`, at: now() }; save(store, 'release', row, 'release.rollback-intent');
    try { const result = await rollback({ operationId: row.rollbackIntent.operationId, candidate, deployment: row.deployment }); evidence(store, row, 'rollback', result); row.status = result?.status === 'applied' ? 'rolled-back' : 'stopped'; row.reason = 'smoke failed'; return save(store, 'release', row, 'release.rollback-settled'); }
    catch { return fail(store, row, 'rollback outcome unknown; no automatic replay'); }
  }
  row.status = 'passed'; row.finishedAt = now(); return save(store, 'release', row, 'release.passed');
}
export async function runEvaluation(store, options) { return exclusive(store, `evaluation:${options.id}`, () => evaluation(store, options)); }
async function evaluation(store, { id, promises, observe, interpret, budget, reassess = false }) {
  assert(id && Array.isArray(promises) && promises.length > 0 && promises.length <= 100 && promises.every(p => p.id && p.description), 'bounded declared promises required');
  assert(new Set(promises.map(p => p.id)).size === promises.length, 'unique promise IDs required');
  assert(typeof observe === 'function', 'evaluation observer required');
  let row = store.get('evaluation', id); const promisesDigest = digest(promises);
  if (row) assert(row.promisesDigest === promisesDigest, 'evaluation identity reused for other promises');
  else row = save(store, 'evaluation', { id, promises, promisesDigest, status: 'running', observations: [], judgments: [], createdAt: now() }, 'evaluation.created');
  if (row.judgments.length && !reassess) return row;
  if (budget?.ceilingMicros > 0) throw new Error('metered evaluation adapters are not enabled');
  if (row.observations.length < promises.length && (row.observations.length || Object.keys(row.observationIntents ?? {}).length)) {
    // A committed journey intent may already have changed external state, even before its first observation.
    for (const promise of promises.filter(p => !row.observations.some(o => o.promiseId === p.id))) {
      const value = { status: 'untested', reason: 'interrupted journey requires a new evaluation' };
      row.observations.push({ promiseId: promise.id, at: now(), value, digest: digest(value) });
    }
    save(store, 'evaluation', row, 'evaluation.interrupted');
  } else if (!row.observations.length) {
    row.observationIntents ??= {};
    for (const promise of promises) {
      row.observationIntents[promise.id] = { status: 'dispatching', at: now(), promiseDigest: digest(promise) };
      save(store, 'evaluation', row, 'evaluation.journey-intent');
      let observation;
      try { observation = await observe(promise); assert(['passed', 'failed', 'untested', 'waitingUntil', 'infra'].includes(observation?.status), 'invalid observation status'); if (observation.status === 'waitingUntil') assert(Number.isFinite(Date.parse(observation.until)), 'waitingUntil requires date'); }
      catch { observation = { status: 'infra', reason: 'observer failed' }; }
      row.observations.push({ promiseId: promise.id, at: now(), value: observation, digest: digest(observation) });
      row.observationIntents[promise.id].status = 'observed'; save(store, 'evaluation', row, 'evaluation.observed');
    }
  }
  let judgment;
  try { judgment = interpret ? await interpret({ promises, observations: structuredClone(row.observations) }) : { outcomes: row.observations.map(o => ({ promiseId: o.promiseId, ...o.value })) }; }
  catch { judgment = { outcomes: promises.map(p => ({ promiseId: p.id, status: 'untested', reason: 'interpretation unavailable' })) }; }
  assert(Array.isArray(judgment.outcomes) && judgment.outcomes.length === promises.length, 'judgment must cover every promise');
  for (const promise of promises) {
    const matches = judgment.outcomes.filter(o => o.promiseId === promise.id); assert(matches.length === 1, 'judgment promise identity mismatch');
    const outcome = matches[0], observation = row.observations.find(o => o.promiseId === promise.id).value;
    assert(['passed', 'failed', 'untested', 'waitingUntil', 'infra'].includes(outcome.status), 'invalid judgment status');
    if (['infra', 'untested', 'waitingUntil'].includes(observation.status) && ['passed', 'failed'].includes(outcome.status)) throw new Error('infrastructure failure cannot prove product pass/fail');
    if (outcome.status === 'waitingUntil') assert(Number.isFinite(Date.parse(outcome.until)), 'waitingUntil judgment requires date');
  }
  row.judgments.push({ at: now(), value: judgment, digest: digest(judgment), observationDigest: digest(row.observations) }); row.status = 'completed'; save(store, 'evaluation', row, 'evaluation.judged'); return row;
}
