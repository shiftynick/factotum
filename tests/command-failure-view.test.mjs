// dev.83 (G19): the console attempt panel shows why a trusted command failed. Fictional data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './fake-dom.mjs';

installDom();
const { commandFailureView } = await import('../starter/factory/console/ui/timeline.mjs');

test('G19: the console attempt panel shows the command failure', () => {
  const node = commandFailureView({ id: 'a1', step: 'gate', failure: { summary: 'the command exited with code 2', exitCode: 2, stderr: 'assertion failed' } });
  assert.match(node.textContent, /Why the command failed/); assert.match(node.textContent, /exited with code 2/); assert.match(node.textContent, /assertion failed/);
  assert.equal(commandFailureView({ id: 'a2', step: 'gate' }), null);
});
