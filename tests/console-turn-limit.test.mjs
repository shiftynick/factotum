// dev.84 review: the Settings view's provider "Turn limit" column shows the effective limit, the
// role's default marked as such when none is configured (60 for builds, 16 otherwise), and that
// Codex takes none. See docs/changes/dev84-flow-fixes.md, "Review fixes".
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';

installDom();
const { turnLimit } = await import('../starter/factory/console/ui/settings.mjs');

test('review: Settings shows the effective turn limit per role, the default marked, and none for Codex', t => {
  const f = sandbox(t);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'm', maxTurns: 30 }, builder: { provider: 'claude', model: 'm' }, reviewer: { provider: 'codex', model: 'r' }, auditor: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  assert.equal(f.command('config.update', { config, note: 'Fictional turn limits' }).status, 'completed');
  const providers = settingsView(f.store).providers;
  assert.deepEqual(Object.fromEntries(Object.entries(providers).map(([role, row]) => [role, [row.maxTurns ?? null, row.defaultMaxTurns]])), { planner: [30, 16], builder: [null, 60], reviewer: [null, 16], auditor: [null, 16] });
  assert.deepEqual(Object.entries(providers).map(turnLimit), ['30', '60 (default)', 'None (Codex has no turn limit)', '16 (default)']);
  assert.equal(turnLimit(['builder', { provider: 'claude' }]), '—', 'a view without the default (an older service) shows nothing rather than a guess');
});
