import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

const pause = new Int32Array(new SharedArrayBuffer(4));
const busy = error => [5, 6].includes(error.errcode) || /database (?:is )?(?:locked|busy)/i.test(error.message);

// Concurrent first opens can deadlock while upgrading SQLite's journal mode;
// busy_timeout alone does not cover every such lock conversion. Release the
// entire failed connection before a bounded retry of idempotent setup SQL.
export function openPrivateSQLite(path, setupSQL, { timeoutMs = 5000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let db;
    try {
      db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=250;');
      db.exec(setupSQL);
      db.exec('PRAGMA busy_timeout=5000;');
      return db;
    } catch (error) {
      try { db?.close(); } catch {}
      if (!busy(error) || Date.now() >= end) throw error;
      Atomics.wait(pause, 0, 0, Math.min(end - Date.now(), 5 + Math.floor(Math.random() * 20)));
    }
  }
}
