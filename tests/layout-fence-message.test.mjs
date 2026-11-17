// dev.83 (G1): what a release before dev.82 prints when it writes to a converted state, and where
// the running guide explains it. The message itself cannot change: SQLite resolves the fence's
// function when it prepares the write, before the fence's RAISE text could run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initProject, Store } from '../starter/factory/core/store.mjs';
import { layoutFenceIntact } from '../starter/factory/core/records.mjs';
import { workflow } from './helpers.mjs';

const MESSAGE = 'no such function: factotum_attempt_intent_layout';

test('G1: an earlier runtime writing to a fenced state gets the message the running guide explains', t => {
  const base = mkdtempSync(join(tmpdir(), 'fence-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), stateDir = join(base, 'state'); mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  initProject({ stateDir, root, name: 'Fictional project', workflow: workflow([process.execPath, '-e', '0']), supervisor: 'process' });
  const store = new Store(stateDir); assert.equal(layoutFenceIntact(store.db), true); store.close();
  // A connection that registers none of this release's functions, as an earlier release's does.
  const earlier = new DatabaseSync(join(stateDir, 'state.sqlite'));
  t.after(() => earlier.close());
  earlier.exec('PRAGMA trusted_schema=ON');
  assert.ok(earlier.prepare("SELECT count(*) AS n FROM meta").get().n > 0, 'reads still work');
  assert.throws(() => earlier.exec("INSERT INTO records(kind,id,data) VALUES ('note','fictional','{}')"), error => error.message === MESSAGE);
  // Short-circuiting does not help: the function is resolved when the write is prepared.
  earlier.exec('CREATE TEMP TABLE t(x)');
  earlier.exec(`CREATE TEMP TRIGGER probe BEFORE INSERT ON t WHEN 0 AND factotum_attempt_intent_layout() < 2 BEGIN SELECT RAISE(ABORT, 'readable'); END`);
  assert.throws(() => earlier.exec('INSERT INTO t VALUES (1)'), error => error.message === MESSAGE);
  const guide = readFileSync(new URL('../docs/running.md', import.meta.url), 'utf8');
  assert.match(guide, new RegExp(`\\*\\*"${MESSAGE}"\\.\\*\\* This is what a release before dev\\.82 prints for every write`));
  assert.match(guide, /run `layout inline` with the newer CLI first/);
});
