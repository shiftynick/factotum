// Knowledge upkeep, slice 8 (review of b46da01, Q8): a flow's page shows the learnings each plan
// cycle pinned: ids, paths, blob ids, flags, and what was skipped, refused or could not be read.
// Rendered into the fake DOM from the data the project service returns; fictional fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, byClass } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 320;
globalThis.document.addEventListener = () => {}; globalThis.window.addEventListener = () => {};
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');

const text = node => node.textContent;
const project = flows => ({ projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: { revision: 1, flows, inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } });
function render(flow) {
  const p = project([{ id: flow.id, state: 'running', step: 'build', taskSnapshot: { title: 'Fictional change' } }]);
  state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', flow.id, {})}`, { status: 'ready', data: { flow, attempts: [], inbox: [], events: [], waits: [], contexts: [], pushback: [], obligations: [], regressions: [] }, fetchedAt: new Date().toISOString(), revision: 1 });
  return byClass(timeline.flowDetail(p, flow.id, { projectId: 'fictional', tab: 'timeline', params: { flow: flow.id } }), 'card').find(node => /^Learnings shown to agents/.test(text(node)));
}
const BLOB = 'a'.repeat(40), OTHER = 'b'.repeat(40), COMMIT = 'c'.repeat(40);

test('Q8: the flow view shows each cycle\'s pinned learnings, as text, at phone width', () => {
  const flow = { id: 'flow-1', kind: 'change', state: 'running', step: 'build', taskId: 'task-1', createdAt: new Date().toISOString(),
    learningHistory: [{ cycle: 1, step: 'plan', commit: COMMIT, at: new Date().toISOString(), learnings: [{ id: 'learning-aaaaaaaaaaa1', blob: OTHER }] }],
    learningSelection: { cycle: 2, step: 'plan', commit: COMMIT, dir: 'docs/learnings', at: new Date().toISOString(),
      entries: [{ id: 'learning-aaaaaaaaaaa2', path: 'docs/learnings/learning-aaaaaaaaaaa2.md', blob: BLOB, chars: 200, flags: ['link'] }],
      skipped: [{ id: 'learning-aaaaaaaaaaa3', reason: 'chars' }],
      refused: [{ path: 'docs/learnings/<img src=x onerror=alert(1)>.md', reason: 'not-a-learning: a learning file is named learning-<12 hexadecimal digits>.md' }] } };
  const card = render(flow);
  assert.ok(card, 'a card for the pinned learnings');
  assert.match(text(card), /Learnings shown to agents \(2 cycles\)/);
  assert.match(text(card), /Cycle 1 \(ended by a replan\) · selected at plan from cccccccccccc…/);
  assert.match(text(card), /learning-aaaaaaaaaaa1 · blob bbbbbbbbbbbb…/);
  assert.match(text(card), /Cycle 2 · selected at plan from cccccccccccc…/);
  assert.match(text(card), /learning-aaaaaaaaaaa2 · docs\/learnings\/learning-aaaaaaaaaaa2\.md · blob aaaaaaaaaaaa… · flagged: link/);
  assert.match(text(card), /Not selected: learning-aaaaaaaaaaa3 \(character budget\)/);
  assert.match(text(card), /1 refused in the store/);
  assert.ok(text(card).includes('docs/learnings/<img src=x onerror=alert(1)>.md'), 'repository names are shown as text');
  assert.equal(byTag(card, 'img').length, 0);
  assert.match(text(card), /It carries no authority/);
  assert.equal(globalThis.innerWidth, 320);
  // A store that could not be read says why; a flow with no pin has no card.
  const unread = render({ ...flow, learningHistory: [], learningSelection: { cycle: 1, step: 'build', commit: null, entries: [], skipped: [], refused: [], problem: 'learning delivery is stopped since 2026-11-16T00:00:00.000Z (learnings-uncited)' } });
  assert.match(text(unread), /Not read: learning delivery is stopped/); assert.match(text(unread), /No learning was selected/);
  assert.equal(render({ ...flow, learningHistory: undefined, learningSelection: undefined }), undefined);
});
