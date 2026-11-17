import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesGlob } from '../starter/factory/core/globs.mjs';
import { matchesExcludeIgnored } from '../starter/factory/operations/workspace-cleanup.mjs';

const check = (cases, options) => {
  for (const [glob, yes, no] of cases) {
    for (const path of yes) assert.equal(matchesGlob(glob, path, options), true, `${glob} matches ${path}`);
    for (const path of no) assert.equal(matchesGlob(glob, path, options), false, `${glob} does not match ${path}`);
  }
};

test('globs: wildcards match path segments that start with a dot like any other', () => {
  check([
    ['node_modules/**', ['node_modules/.pnpm/x/bin/y', 'node_modules/.bin/z', 'node_modules/.modules.yaml', 'node_modules/a/.b/.c'], ['other/node_modules/.pnpm/x']],
    ['**/node_modules/**', ['node_modules/.pnpm/x', 'apps/web/node_modules/.bin/z', '.hidden/node_modules/.cache/a'], ['apps/web/node_modulesx/a']],
    ['.next/**', ['.next/cache/webpack/x.pack', '.next/.trace'], ['apps/web/.next/cache/x', '.nextx/a']],
    ['*', ['.env', 'a'], ['a/.env']],
    ['docs/*.md', ['docs/.draft.md'], ['docs/.x/a.md']],
    ['src/?a', ['src/.a'], ['src/a', 'src//a']],
  ]);
});

test('globs: ** at the start, middle and end; a single * and ? never cross /', () => {
  check([
    ['**/a.txt', ['a.txt', 'x/a.txt', 'x/.y/a.txt'], ['a.txtx', 'x/ba.txt']],
    ['src/**/a.txt', ['src/a.txt', 'src/x/a.txt', 'src/x/.y/z/a.txt'], ['srca.txt', 'other/src/a.txt']],
    ['src/**', ['src/a', 'src/.a/b'], ['src', 'srcx/a']],
    ['a/**b', ['a/b', 'a/x/yb'], ['ab']],
    ['src/*.js', ['src/a.js', 'src/.js'], ['src/a/b.js', 'src/a.jsx']],
    ['*/x', ['a/x', '.a/x'], ['a/b/x', 'x']],
  ]);
});

test('globs: the directory option lets dir/** match the directory itself, and nothing more', () => {
  const options = { directory: true };
  check([
    ['node_modules/**', ['node_modules', 'node_modules/.pnpm'], ['node_modulesx', 'apps/node_modules']],
    ['**/node_modules/**', ['node_modules', 'apps/web/node_modules', 'apps/web/node_modules/.bin'], ['apps/web/node_modulesx']],
    ['dist/*', ['dist/a'], ['dist']],
    ['dist', ['dist'], ['dist/a']],
  ], options);
  assert.equal(matchesGlob('node_modules/**', 'node_modules'), false, 'off by default: knowledge upkeep matches files only');
});

test('globs: extended syntax adds classes, braces and escapes; without it they are literal', () => {
  const options = { extended: true };
  check([
    ['{dist,build}/**', ['dist/a', 'build/.cache/b'], ['out/a', '{dist,build}/a']],
    ['a{,.min}.js', ['a.js', 'a.min.js'], ['a.max.js']],
    ['{x,{y,z}}/*', ['x/1', 'z/1'], ['w/1']],
    ['{only}/a', ['{only}/a'], ['only/a']],
    ['log[0-9].txt', ['log1.txt'], ['logx.txt', 'log/.txt']],
    ['a[!b]c', ['axc', 'a.c'], ['abc', 'a/c']],
    ['a[]]', ['a]'], ['a']],
    ['\\*.txt', ['*.txt'], ['a.txt']],
    ['a[b', ['a[b'], ['ab']],
  ], options);
  check([['{a,b}', ['{a,b}'], ['a']], ['[ab]', ['[ab]'], ['a']]]);
});

test('cleanup.excludeIgnored: dot segments, the directory itself and a collapsed directory listing', () => {
  const globs = ['node_modules/**', '**/node_modules/**', '.next/**', '.artifacts/**'];
  for (const path of ['node_modules/.pnpm/x/bin/y', 'apps/web/node_modules/.bin/z', 'node_modules', 'node_modules/', 'apps/web/node_modules/', '.next/cache/x', '.artifacts'])
    assert.equal(matchesExcludeIgnored(path, globs), true, path);
  for (const path of ['src/index.js', 'apps/web/.next/cache/x', 'node_modulesx/a', '.env'])
    assert.equal(matchesExcludeIgnored(path, globs), false, path);
  assert.equal(matchesExcludeIgnored('node_modules/a', []), false);
});
