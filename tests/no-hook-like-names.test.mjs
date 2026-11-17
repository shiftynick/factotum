import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Adopting projects lint the installed core with their own rules. React's rules-of-hooks treats any
// call to a function named use<Capital> outside a component as an error, so the core never declares
// or calls one.
const root = new URL('../starter/factory/', import.meta.url).pathname;
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : []);

test('the installed core declares and calls no hook-like use<Capital> functions', () => {
  const found = [];
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b(use[A-Z]\w*)\s*\(/g)) found.push(`${file.slice(root.length)}: ${match[1]}`);
  }
  assert.deepEqual(found, []);
});
