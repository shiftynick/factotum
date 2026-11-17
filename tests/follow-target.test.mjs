import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { followTarget } from '../starter/factory/workflows/actions.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function commit(root, path) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), `${path} ${Math.random()}\n`); git(root, 'add', '.'); git(root, 'commit', '-qm', `Change ${path}`); return git(root, 'rev-parse', 'HEAD'); }
const build = { action: { operation: 'provider.build' } };

function setup(t, { files = ['site/page.html'], config } = {}) {
  const f = sandbox(t), base = git(f.root, 'rev-parse', 'HEAD');
  f.store.put('task', { ...f.store.need('task', 'task-1'), paths: [] });
  f.store.put('flow', { id: 'fl', taskId: 'task-1', state: 'ready', step: 'build', workflow: { nodes: {} }, sessions: { builder: 's' }, results: { plan: { targetBase: base, result: { files } }, integrate: { base } } });
  if (config) f.store.setMeta('config', { ...f.store.meta('config'), ...config });
  return { f, base };
}
const moveMain = (f, path) => { const head = commit(f.root, path); const flow = f.store.need('flow', 'fl'); f.store.put('flow', { ...flow, results: { ...flow.results, integrate: { base: head } } }); return head; };

test('main moving outside the planned paths is followed and recorded', t => {
  const { f, base } = setup(t), head = moveMain(f, 'research/notes.md');
  const result = followTarget(f.store, f.store.need('flow', 'fl'), build, { replan: () => assert.fail('no replan') });
  assert.equal(result.followed, true);
  const flow = f.store.need('flow', 'fl');
  assert.equal(flow.results.plan.targetBase, head); assert.deepEqual(flow.targetFollows[0].changed, ['research/notes.md']); assert.equal(flow.targetFollows[0].from, base);
  assert.ok(f.store.events(10).some(e => e.type === 'flow.target-followed'));
});

test('main changing a planned path replans; following can be turned off', t => {
  const { f } = setup(t); moveMain(f, 'site/page.html');
  let replanned = null;
  const result = followTarget(f.store, f.store.need('flow', 'fl'), build, { replan: (store, flow, options) => { replanned = options; } });
  assert.equal(result.replanned, true); assert.equal(replanned.by, 'factory'); assert.match(replanned.note, /site\/page\.html/);
  const off = setup(t, { config: { policy: { followTarget: false } } }); moveMain(off.f, 'research/notes.md');
  assert.deepEqual(Object.keys(followTarget(off.f.store, off.f.store.need('flow', 'fl'), build, { replan: () => assert.fail() })), ['flow'], 'unchanged: the build check stops it as before');
});

test('with no planned paths known, any change to main replans', t => {
  const { f } = setup(t, { files: [] }); moveMain(f, 'research/notes.md');
  let called = false;
  followTarget(f.store, f.store.need('flow', 'fl'), build, { replan: () => { called = true; } });
  assert.ok(called);
});

test('main moving before the first build is followed too, and a changed governing file replans', async t => {
  const { repositoryIdentity } = await import('../starter/factory/core/repository.mjs');
  const { f } = setup(t), flow = f.store.need('flow', 'fl');
  f.store.put('flow', { ...flow, sessions: {}, results: { plan: { ...flow.results.plan, identity: repositoryIdentity(f.root) } } });
  const head = commit(f.root, 'research/notes.md');
  assert.equal(followTarget(f.store, f.store.need('flow', 'fl'), build, { replan: () => assert.fail() }).followed, true);
  assert.equal(f.store.need('flow', 'fl').results.plan.identity.head, head);
  f.store.setMeta('config', { ...f.store.meta('config'), context: { files: [{ id: 'rules', path: 'GOVERNANCE.md' }], maxChars: 1000 } });
  commit(f.root, 'GOVERNANCE.md');
  let called = false; followTarget(f.store, f.store.need('flow', 'fl'), build, { replan: () => { called = true; } });
  assert.ok(called, 'a governing file changed');
});
