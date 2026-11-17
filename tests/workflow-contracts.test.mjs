import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../starter/factory/core/contracts.mjs';

const end = { kind: 'end', outcome: 'completed' };
test('workflow rejects unknown edges, missing failure paths and invalid bounds', () => {
  assert.throws(() => validateWorkflow({ version: 1, start: 'x', nodes: { x: { kind: 'effect', argv: ['true'], timeoutMs: 100, next: 'done' }, done: end } }), /failure transitions/);
  assert.throws(() => validateWorkflow({ version: 1, start: 'x', nodes: { x: { kind: 'question', role: 'operator', question: 'go?', answers: { yes: 'absent' } } } }), /unknown workflow edge/);
  assert.throws(() => validateWorkflow({ version: 1, maxTransitions: -1, start: 'done', nodes: { done: end } }), /transition bound/);
});
test('every cycle must cross an explicitly bounded node', () => {
  const workflow = { version: 1, start: 'a', nodes: {
    a: { kind: 'question', role: 'operator', question: 'retry?', answers: { yes: 'b', no: 'done' } },
    b: { kind: 'question', role: 'operator', question: 'again?', answers: { yes: 'a' } }, done: end,
  } };
  assert.throws(() => validateWorkflow(workflow), /unbounded/);
  workflow.nodes.b.maxVisits = 2;
  assert.equal(typeof validateWorkflow(workflow), 'string');
  workflow.nodes.a.answers.self = 'a';
  assert.throws(() => validateWorkflow(workflow), /unbounded/);
});
