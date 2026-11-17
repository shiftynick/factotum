import test from 'node:test';
import assert from 'node:assert/strict';

// Browser modules read only these globals at import time; no DOM is rendered here.
const old = Object.fromEntries(['document', 'localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperties(globalThis, {
  document: { configurable: true, value: { querySelector: () => ({ content: 'fictional-csrf' }) } },
  localStorage: { configurable: true, value: { getItem: () => null } },
  sessionStorage: { configurable: true, value: { getItem: () => null } },
});
const { detailParams } = await import('../starter/factory/console/ui/state.mjs');
const { syncQueueDraft, resetQueueDraft } = await import('../starter/factory/console/ui/plan.mjs');
for (const [key, descriptor] of Object.entries(old)) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else delete globalThis[key];
}

test('the detail modal opens over the current page and closes back to it', () => {
  const history = { projectId: 'p', tab: 'history', params: { kind: 'flow', attempt: 'a1' } };
  assert.deepEqual(detailParams(history, { flow: 'f1' }), { kind: 'flow', flow: 'f1', attempt: undefined, task: undefined });
  assert.deepEqual(detailParams({ ...history, params: { kind: 'flow', flow: 'f1' } }, { task: 't1' }), { kind: 'flow', flow: undefined, attempt: undefined, task: 't1' });
  assert.deepEqual(detailParams({ ...history, params: { kind: 'flow', task: 't1' } }), { kind: 'flow', flow: undefined, attempt: undefined, task: undefined }, 'closing clears it');
  // On Tasks, ?task is the page's own selection: closing a flow keeps it.
  assert.equal(detailParams({ projectId: 'p', tab: 'tasks', params: { task: 't1', flow: 'f1' } }).task, 't1');
});

test('unsaved queue order retains its original binding until explicitly discarded', () => {
  const current = ['task-a', 'task-b'];
  const ui = syncQueueDraft({}, current, 'original-binding');
  Object.assign(ui, { order: ['task-b', 'task-a'], dirty: true });
  syncQueueDraft(ui, current, 'replacement-binding');
  assert.equal(ui.bindingId, 'original-binding');
  assert.deepEqual(ui.order, ['task-b', 'task-a']);
  assert.equal(ui.dirty, true);
  resetQueueDraft(ui, current, 'replacement-binding');
  assert.equal(ui.bindingId, 'replacement-binding');
  assert.deepEqual(ui.order, current);
  assert.equal(ui.dirty, false);
  // Clean drafts follow new canonical registrations without retaining stale edits.
  syncQueueDraft(ui, ['task-c'], 'third-binding');
  assert.equal(ui.bindingId, 'third-binding');
  assert.deepEqual(ui.order, ['task-c']);
});
