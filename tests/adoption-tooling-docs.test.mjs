// dev.83 (G18): the adoption guide and the setup checklist tell adopters to keep their own
// repository-wide tooling off the installed Factotum files, with examples for common tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('G18: the adoption guide says to exclude the installation from project-wide tooling, with examples', () => {
  const guide = read('../docs/adoption.md');
  const section = guide.slice(guide.indexOf('### Keep project-wide tooling off the installed files'), guide.indexOf('The installed [core agent policy]'));
  assert.ok(section.length > 500, 'section present before the core agent policy paragraph');
  for (const tool of ['ESLint', 'Prettier', 'TypeScript', 'Jest / Vitest', 'Ruff', 'pytest', 'markdownlint', 'codespell', 'pre-commit']) assert.match(section, new RegExp(`\\| ${tool.replace(/[/]/g, '\\/')}`), tool);
  assert.match(section, /factotum\.lock\.json/); assert.match(section, /`factory\/`, `project\/`, `VERSION`, `compatibility\.json`/);
  assert.match(section, /Do not edit, reformat or rename managed files to satisfy a local rule: that is drift, which doctor refuses/);
  assert.match(section, /From dev\.83 the core declares and calls no functions named like React hooks/);
  const checklist = read('../starter/project/SETUP_CHECKLIST.md');
  assert.match(checklist, /\*\*Your own repository-wide checks\.\*\* Exclude the installed files/);
  // The checklist is installed into the project, where Factotum's docs are not: it names the section in the reference (dev.85, I5d).
  assert.match(checklist, /`docs\/adoption\.md#keep-project-wide-tooling-off-the-installed-files` in the Factotum reference/);
});
