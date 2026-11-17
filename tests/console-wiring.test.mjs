import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const consoleDir = join(import.meta.dirname, '../starter/factory/console');
const server = readFileSync(join(consoleDir, 'console.mjs'), 'utf8');
const views = readdirSync(join(consoleDir, 'ui')).filter(name => name.endsWith('.mjs'));

test('every command the console views send is accepted by the console server', () => {
  const supported = new Set(JSON.parse(server.match(/const supported = (\[[^\]]*\])/)[1].replaceAll("'", '"')));
  const sent = new Set();
  for (const name of [...views.map(v => join('ui', v)), 'ui.mjs']) for (const match of readFileSync(join(consoleDir, name), 'utf8').matchAll(/operation\s*:\s*'([a-z.]+)'/g)) sent.add(match[1]);
  const maintenance = new Set(['source.sync', 'source.create', 'source.promote', 'queue.dispatch', 'main.verify']); // job.enqueue payload operations
  const missing = [...sent].filter(operation => !supported.has(operation) && !maintenance.has(operation));
  assert.deepEqual(missing, []);
  assert.ok(sent.has('job.enqueue') && sent.has('recurring.run') && sent.has('schedule.pause') && sent.has('task.schedule'));
});

test('every console view module is served', () => {
  for (const name of views) assert.ok(server.includes(`'${name.slice(0, -4)}'`), `ui/${name} is not in the console's static assets`);
});
