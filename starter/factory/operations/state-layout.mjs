import { createServer } from 'node:net';
import { assert, now } from '../core/contracts.mjs';
import { INTENT_KIND, INTENT_TEXT, KIND_INDEXES, STATE_INDEXES, VERIFIED_META, ensureStateIndexes, installLayoutFence, invalidateVerification, recordVerification, removeLayoutFence } from '../core/records.mjs';
import { NotLossless, hasDuplicateKeys, inlineIntentText, intentMembers, readIntentRecord, separateIntentText } from '../core/intent-text.mjs';
import { Store, schemaTrusted } from '../core/store.mjs';

// Brings a state database to this release's record layout (core/records.mjs) and takes it
// back. The schema version does not change.
//
// Forward (migrateStateLayout; the project service runs it when it starts):
// 1. Install the layout fence. From here on, no connection of an earlier release can write
//    this database: it reads the intent only inline and would misjudge every attempt.
// 2. Move each attempt's inline intent to its own record, by cutting the record text
//    (core/intent-text.mjs): no byte of the intent or of the rest of the attempt is
//    reserialised, and the intent record keeps what is needed to put the original text back.
//    Before anything is written for an attempt, the two new texts are checked: both parse,
//    they hold the same values as the original, and joining them again gives the original
//    text exactly. An attempt that fails a check is refused: it is left as it is and reported.
// 3. Verify the kinds SQL reads as JSON: SQLite's JSON functions read the first of two members
//    of one name and JSON.parse the last, so a kind is indexed (and read through SQL at all)
//    only when none of its records has such a pair, at any depth. A kind that has one is
//    reported, gets no index and is read whole in JavaScript (core/records.mjs). The fence
//    keeps a verified kind verified: from here on only Store.put (JSON.stringify output) and
//    this module (text it has checked) write records.
// 4. In the same transaction as that check, record which kinds are verified and create
//    their indexes (over the now short attempts). Step 1 deletes that record and drops every
//    index in its own transaction, so nothing from before the fence is trusted, whatever
//    interrupts the run.
// Safe to run at any time and any number of times, and safe to interrupt: every Store read
// answers the same for either layout, each attempt's two records are written in one
// transaction, and transactions are of bounded size. A run that stops early leaves the rest
// inline; the next run continues.
//
// Back (inlineAttemptIntents; `layout inline`, and Factotum's own paths to an earlier
// release): put every intent back into its attempt, then, in the transaction that finds no
// separate intent left, delete the record of verification, drop the indexes and remove the
// fence: without the fence nothing is verified, and nothing is left that a later fence could
// be taken to vouch for. An attempt record that was not rewritten
// since its intent was moved gets its original text back byte for byte; one this runtime
// wrote or rewrote gets the text this runtime writes inline.
// Attempts whose text could hold an intent member (core/records.mjs INTENT_TEXT). Whether one
// does is decided on its text by the scanner, which agrees with JSON.parse: any top-level
// member named intent counts, a null one and the first of several included.
const candidateIds = store => store.db.prepare(`SELECT id FROM records ${store.hint('records_inline_intent')} WHERE kind='attempt' AND ${INTENT_TEXT} ORDER BY rowid`).all().map(row => row.id);
// 0 when the record has no intent member, 1 when it has exactly one (it can be moved), and the
// reason it cannot be moved otherwise: several intent members, an intent with two members of
// one name in some object (SQLite and JSON.parse would read it differently), or a text the
// scanner cannot read.
const DUPLICATE = 'two fields of one name in an object';
function inlineIntent(id, text) {
  try {
    const count = intentMembers(text); if (count !== 1) return count ? { count, unmovable: 'the record has more than one intent field' } : { count };
    return hasDuplicateKeys(readIntentRecord(id, separateIntentText(id, text).intent).value) ? { count, unmovable: `the intent has ${DUPLICATE}` } : { count };
  } catch (error) { if (!(error instanceof NotLossless) && !(error instanceof SyntaxError)) throw error; return { count: 1, unmovable: `the record cannot be read as JSON (${error.message})` }; }
}
// Records of these kinds that SQL and JSON.parse would not read alike, by kind: one with two
// members of one name in some object, or one that is not JSON. `checked` names intent records
// already checked in this run.
function duplicateKeyRecords(store, kinds, checked = new Set()) {
  const found = {};
  for (const kind of kinds) for (const row of store.db.prepare('SELECT id, data FROM records WHERE kind=? ORDER BY rowid').iterate(kind)) {
    if (kind === INTENT_KIND && checked.has(row.id)) continue;
    let reason = null; try { if (hasDuplicateKeys(row.data)) reason = `the record has ${DUPLICATE}`; } catch (error) { reason = `the record cannot be read as JSON (${error.message})`; }
    if (reason) (found[kind] ??= []).push({ id: row.id, reason });
  }
  return found;
}
// The name a release's compatibility.json gives this layout in recordLayouts.
export const SEPARATE_INTENTS = 'separate-intents';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function stateLayout(store) {
  const found = new Map(store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='records'").all().map(row => [row.name, row.sql]));
  const missingIndexes = STATE_INDEXES.filter(index => found.get(index.name) !== index.sql).map(index => index.name);
  const read = store.db.prepare("SELECT data FROM records WHERE kind='attempt' AND id=?"), inline = [], unmovable = [];
  for (const id of candidateIds(store)) { const row = read.get(id); if (!row) continue; const member = inlineIntent(id, row.data); if (!member.count) continue; inline.push(id); if (member.unmovable) unmovable.push({ attemptId: id, reason: member.unmovable }); }
  const separate = store.layout().separate, verification = store.meta(VERIFIED_META, null), recorded = Array.isArray(verification?.kinds), duplicates = verification?.duplicates ?? {};
  return { current: separate && recorded && !inline.length && !missingIndexes.length && !Object.keys(duplicates).length, layout: separate ? SEPARATE_INTENTS : 'inline', olderReleasesCanWrite: !separate,
    inlineIntents: inline.length, ...(inline.length ? { inlineAttempts: inline.slice(0, 20) } : {}), ...(unmovable.length ? { unmovable: unmovable.slice(0, 20) } : {}), separateIntents: store.count(INTENT_KIND), verifiedKinds: separate && recorded ? verification.kinds.filter(kind => store.verified(kind)) : [], ...(Object.keys(duplicates).length ? { unverifiedKinds: duplicates } : {}), missingIndexes, lastMigration: store.meta('stateLayout', null) };
}

// The attempt and intent record texts for one inline attempt, checked; throws NotLossless.
function separated(id, text) {
  let original; try { original = JSON.parse(text); } catch { throw new NotLossless('the record is not valid JSON'); }
  const { attempt, intent } = separateIntentText(id, text);
  let shortened, moved;
  try { shortened = JSON.parse(attempt); moved = JSON.parse(intent); } catch { throw new NotLossless('a separated record would not be valid JSON'); }
  const { intent: value, ...rest } = original;
  if (!same(moved.intent, value) || !same(JSON.parse(readIntentRecord(id, intent).value), value) || 'intent' in shortened || !same(shortened, rest)) throw new NotLossless('the separated records would not hold the original values');
  if (inlineIntentText(id, attempt, intent) !== text) throw new NotLossless('the original text could not be restored from the separated records');
  return { attempt, intent };
}

export function migrateStateLayout(store, { chunkBytes = 8 * 1024 * 1024 } = {}) {
  assert(Number.isSafeInteger(chunkBytes) && chunkBytes > 0, 'positive migration chunk size required');
  assert(schemaTrusted(store.db), 'this SQLite connection does not trust its schema, so it could not write behind the layout fence; the state stays in the inline layout');
  const started = Date.now(), fenced = !store.layout().separate;
  // Installing the fence invalidates whatever was verified and indexed before it: without the fence
  // anything could write, so an index that survived (or a record of verification) proves nothing.
  if (fenced) store.tx(() => { installLayoutFence(store.db); invalidateVerification(store.db); });
  const ids = candidateIds(store), read = store.db.prepare("SELECT data FROM records WHERE kind='attempt' AND id=?"), refused = [], movedIds = new Set();
  let moved = 0, at = 0;
  while (at < ids.length) {
    store.tx(() => {
      for (let bytes = 0; at < ids.length && bytes < chunkBytes; at++) {
        const id = ids[at], row = read.get(id); if (!row) continue;
        const member = inlineIntent(id, row.data); if (!member.count) continue;
        if (member.unmovable) { refused.push({ attemptId: id, reason: member.unmovable }); continue; }
        let texts; try { texts = separated(id, row.data); } catch (error) { if (!(error instanceof NotLossless)) throw error; refused.push({ attemptId: id, reason: error.message }); continue; }
        // The intent record first (replacing a stale one), then the attempt without it.
        store.write(INTENT_KIND, id, texts.intent); store.write('attempt', id, texts.attempt);
        bytes += row.data.length; moved++; movedIds.add(id);
      }
    });
  }
  // Verify in one transaction: check the kinds, record which are verified and create their indexes.
  // Every kind SQL reads as JSON when nothing is recorded (a new fence, an interrupted run); otherwise
  // only the kinds last found wanting, which a put may have repaired. Kinds recorded as verified stay
  // so: the fence has been in place since.
  const { duplicates, unverified, indexes, recorded, rerecorded } = store.tx(() => {
    const previous = store.meta(VERIFIED_META, null), recorded = Array.isArray(previous?.kinds), all = [...KIND_INDEXES.keys()];
    // A kind this release indexes that the record does not mention (a release before this one wrote the
    // record) is checked like one last found wanting. The fence has been in place since the record was
    // written, so only Store.put has written it; the check is what makes it verified, not that argument.
    const unrecorded = recorded ? all.filter(kind => !previous.kinds.includes(kind) && !Object.hasOwn(previous.duplicates ?? {}, kind)) : [];
    const kinds = recorded ? [...Object.keys(previous.duplicates ?? {}), ...unrecorded] : all, duplicates = kinds.length ? duplicateKeyRecords(store, kinds, movedIds) : {}, unverified = Object.keys(duplicates);
    const listed = Object.fromEntries(Object.entries(duplicates).map(([kind, found]) => [kind, found.slice(0, 20)])), rerecorded = !recorded || unrecorded.length > 0 || JSON.stringify(listed) !== JSON.stringify(previous.duplicates ?? {});
    if (rerecorded) recordVerification(store.db, { at: now(), kinds: all.filter(kind => !unverified.includes(kind)), duplicates: listed });
    return { duplicates, unverified, indexes: ensureStateIndexes(store.db, { unverified }), recorded, rerecorded };
  });
  const result = { movedIntents: moved, ...(refused.length ? { refused } : {}), ...(unverified.length ? { unverifiedKinds: duplicates } : {}), indexes, ...(fenced ? { fenceInstalled: true } : {}) };
  if (!moved && !indexes.length && !fenced && !(rerecorded && recorded)) return { changed: false, ...result };
  result.durationMs = Date.now() - started;
  store.tx(() => { store.setMeta('stateLayout', { migratedAt: now(), ...result, refused: refused.slice(0, 20) }); store.event('state.layout-migrated', { ...result, refused: refused.slice(0, 20) }); });
  return { changed: true, ...result };
}

// Put every separate intent back into its attempt and, when none is left, remove the fence.
// An intent whose attempt was never written (a crash between the two writes) is not an
// attempt's intent and is left in place. An attempt that cannot be rebuilt is refused and
// reported; the fence then stays, because separate intents remain.
export function inlineAttemptIntents(store, { chunkBytes = 8 * 1024 * 1024 } = {}) {
  assert(Number.isSafeInteger(chunkBytes) && chunkBytes > 0, 'positive chunk size required');
  const ids = store.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY rowid').all(INTENT_KIND).map(row => row.id);
  const read = store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?'), remove = store.db.prepare('DELETE FROM records WHERE kind=? AND id=?'), refused = [];
  let restored = 0, orphans = 0, at = 0;
  while (at < ids.length) {
    store.tx(() => {
      for (let bytes = 0; at < ids.length && bytes < chunkBytes; at++) {
        const id = ids[at], attempt = read.get('attempt', id)?.data, intent = read.get(INTENT_KIND, id)?.data;
        if (!intent) continue;
        if (attempt === undefined) { orphans++; continue; }
        try {
          const before = JSON.parse(attempt);
          // An attempt whose own record has an intent member has that intent; the separate record is stale.
          if (!Object.hasOwn(before, 'intent')) {
            const text = inlineIntentText(id, attempt, intent), after = JSON.parse(text), { intent: value, ...rest } = after;
            const { intent: unset, ...slim } = before;
            if (!same(value, JSON.parse(readIntentRecord(id, intent).value)) || !same(rest, slim)) throw new NotLossless('the rebuilt record would not hold the original values');
            store.write('attempt', id, text);
          }
          remove.run(INTENT_KIND, id); bytes += attempt.length + intent.length; restored++;
        } catch (error) { if (!(error instanceof NotLossless) && !(error instanceof SyntaxError)) throw error; refused.push({ attemptId: id, reason: error.message }); }
      }
    });
  }
  // The fence goes only in the transaction that sees no attempt's intent stored separately.
  const fenceRemoved = store.tx(() => {
    const left = store.db.prepare("SELECT count(*) AS count FROM records i WHERE i.kind=? AND EXISTS (SELECT 1 FROM records a WHERE a.kind='attempt' AND a.id=i.id)").get(INTENT_KIND).count;
    if (left || !store.layout().separate) return false;
    // Without the fence anything may write: in this same transaction, what was verified no longer
    // is, and the indexes built on it go.
    store.setMeta('stateLayout', { inlinedAt: now(), restoredIntents: restored }); store.event('state.layout-inlined', { restoredIntents: restored, orphanIntents: orphans });
    invalidateVerification(store.db); removeLayoutFence(store.db); return true;
  });
  return { restoredIntents: restored, orphanIntents: orphans, ...(refused.length ? { refused } : {}), fenceRemoved, layout: store.layout().separate ? SEPARATE_INTENTS : 'inline' };
}

// For Factotum's own paths to another release (upgrade apply, upgrade activate): a release
// whose compatibility.json does not declare this layout reads intents only inline, so the
// state is returned to the inline layout before that release's code runs. Returns null when
// nothing needed doing; throws when an attempt could not be inlined.
export const readsSeparateIntents = compatibility => Array.isArray(compatibility?.recordLayouts) && compatibility.recordLayouts.includes(SEPARATE_INTENTS);
export function inlineForRelease(store, compatibility) {
  if (readsSeparateIntents(compatibility) || !store.layout().separate && !store.count(INTENT_KIND)) return null;
  const result = inlineAttemptIntents(store);
  assert(result.layout === 'inline', `the target release reads attempt intents only inline, and ${result.refused?.length ?? 0} attempt(s) could not be returned to that layout (${(result.refused ?? []).slice(0, 5).map(row => `${row.attemptId}: ${row.reason}`).join('; ')}); the state stays in the separate layout`);
  return result;
}

// Offline entry points for the CLI. Both changes need the project runner stopped: the running
// service migrates by itself when it starts, and inlining under a running service would be
// undone by the attempts it writes next.
async function withStoppedRunner(stateDir, fn) {
  const store = new Store(stateDir), lock = createServer(); let owned = false;
  try {
    await new Promise((done, reject) => { lock.once('error', () => reject(new Error('the project runner is still running; stop it (or its unit) first'))); lock.listen(`\0factotum-runner-${store.meta('project').projectId}`, () => { owned = true; done(); }); });
    return fn(store);
  } finally { if (owned) await new Promise(done => lock.close(done)); store.close(); }
}
export function layoutStatus(stateDir) { const store = new Store(stateDir); try { return stateLayout(store); } finally { store.close(); } }
export const migrateLayout = stateDir => withStoppedRunner(stateDir, store => ({ ...migrateStateLayout(store), status: stateLayout(store) }));
export const inlineLayout = stateDir => withStoppedRunner(stateDir, store => ({ ...inlineAttemptIntents(store), status: stateLayout(store) }));
