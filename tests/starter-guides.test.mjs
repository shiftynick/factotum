// dev.85 I5d: the starter's guides still work once they are copied into a project. Factotum's own
// docs are not installed into an adopting project (only VERSION, compatibility.json, factory/ and
// project/ are), so a relative link from an installed file must stay inside the installation; a
// skill folder is copied into the agent's skills directory, so its links stay inside the folder; a
// `.template.md` is copied anywhere, so it has none. References to Factotum's docs are written as
// "`docs/…` in the Factotum reference" and must name a doc and heading that exist. The two T3
// templates mark their fill-in placeholders `[[name]]`, list every one in a template note, and,
// filled in with their note and optional sections handled, leave no placeholder or template text.
// See docs/changes/dev85-retest-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STARTER = join(ROOT, 'starter');
const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const GUIDES = walk(STARTER).filter(path => path.endsWith('.md'));
const read = path => readFileSync(path, 'utf8');
// GitHub's heading anchors: lower case, punctuation other than hyphens and underscores dropped, spaces to hyphens.
const slug = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
const anchors = text => new Set(text.split('\n').filter(line => /^#{1,6} /.test(line)).map(line => slug(line.replace(/^#+ /, ''))));
const links = text => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]);
const external = target => /^(https?:|mailto:|t3-thread:)/.test(target);

// Where a starter file's relative links may point once it is copied into a project.
function allowedRoot(file) {
  const rel = relative(STARTER, file);
  if (rel.endsWith('.template.md')) return null; // copied anywhere: no relative link survives
  const skill = rel.match(/^project\/skills\/[^/]+\//);
  if (skill) return join(STARTER, skill[0]); // copied into the agent's skills directory
  return STARTER; // installed beside factory/ and project/, with or without a prefix
}

test('I5d: every relative link in a starter guide resolves inside what is installed, with its heading', () => {
  const broken = [];
  for (const file of GUIDES) {
    const text = read(file), root = allowedRoot(file);
    for (const target of links(text).filter(t => !external(t))) {
      const [path, fragment] = target.split('#');
      const where = `${relative(ROOT, file)} → ${target}`;
      if (!path) { if (fragment && !anchors(text).has(fragment)) broken.push(`${where}: no such heading`); continue; }
      if (root === null) { broken.push(`${where}: a template copied anywhere has no relative links`); continue; }
      const resolved = normalize(join(dirname(file), path));
      if (!resolved.startsWith(root)) { broken.push(`${where}: outside ${relative(ROOT, root) || '.'}, so not there after adoption`); continue; }
      if (!existsSync(resolved)) { broken.push(`${where}: missing`); continue; }
      if (fragment && resolved.endsWith('.md') && !anchors(read(resolved)).has(fragment)) broken.push(`${where}: no such heading`);
    }
  }
  assert.deepEqual(broken, []);
});

test('I5d: references to the Factotum reference name docs and headings that exist', () => {
  const missing = [];
  let seen = 0;
  for (const file of GUIDES) {
    for (const [, path, fragment] of read(file).matchAll(/`(docs\/[^`#\s]+\.md)(?:#([^`\s]+))?` in the Factotum reference/g)) {
      seen++;
      const target = join(ROOT, path);
      if (!existsSync(target)) missing.push(`${relative(ROOT, file)}: ${path} missing`);
      else if (fragment && !anchors(read(target)).has(fragment)) missing.push(`${relative(ROOT, file)}: ${path}#${fragment} has no such heading`);
    }
  }
  assert.ok(seen > 10, `references found: ${seen}`);
  assert.deepEqual(missing, []);
});

// ---- The T3 templates -------------------------------------------------------------------------------

const TEMPLATES = ['starter/project/integrations/t3-notifications.example.md', 'starter/project/integrations/t3-triage.example.md'];
const NOTE = /<!-- template note: start -->\n[\s\S]*?<!-- template note: end -->\n\n?/;
const OPTIONAL = /<!-- optional: ([a-z-]+) -->\n([\s\S]*?)<!-- end optional -->\n/g;
const PLACEHOLDER = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g;
// The text left in a project's copy: the note deleted, each optional section kept or deleted, the markers removed.
function fill(text, keep) {
  return text.replace(NOTE, '').replace(OPTIONAL, (_, name, body) => keep(name) ? body : '').replace(PLACEHOLDER, (_, name) => `FILLED-${name}`);
}

for (const path of TEMPLATES) {
  test(`I5d: ${path.split('/').at(-1)} lists every placeholder in its template note, and a filled-in copy has no template text left`, () => {
    const text = read(join(ROOT, path)), note = text.match(NOTE)?.[0];
    assert.ok(note, 'the template note is marked so a copy can delete it whole');
    const listed = new Set([...note.matchAll(/^> \| `\[\[([a-z0-9-]+)\]\]` \|/gm)].map(match => match[1]));
    const used = new Set([...text.replace(NOTE, '').matchAll(PLACEHOLDER)].map(match => match[1]));
    assert.ok(used.size >= 5, `placeholders used: ${[...used]}`);
    assert.deepEqual([...used].filter(name => !listed.has(name)), [], 'every placeholder used is listed, so filling in the list replaces them all');
    assert.deepEqual([...listed].filter(name => !used.has(name)), [], 'every listed placeholder is used');
    const sections = [...text.matchAll(OPTIONAL)].map(match => match[1]);
    for (const name of sections) assert.match(note, new RegExp(`\`optional: ${name}\``), `the note says when to keep ${name}`);
    for (const keep of [() => true, () => false]) {
      const copy = fill(text, keep);
      assert.doesNotMatch(copy, /\[\[[a-z0-9-]+\]\]/, 'no placeholder is left');
      assert.doesNotMatch(copy, /<!--/, 'no marker is left');
      for (const phrase of [/Copy this file/, /fill in the placeholders/i, /Leave this section out/, /leave it out/, /template note/i, /\.\.\/\.\.\/docs/])
        assert.doesNotMatch(copy, phrase);
      // The old placeholder forms: a hyphenated name or an explanation in angle brackets reads like a
      // value to fill in at each run (or, in a shell command, a redirect). Per-run values remain, in
      // words or camel case: <inboxId>, <this thread id>.
      assert.deepEqual(copy.match(/<[a-z0-9]+(?:-[a-z0-9]+)+>|<[^<>\n]*(?:default|HH:MM)[^<>\n]*>/g) ?? [], []);
    }
    // An unfilled copy is caught by the reader: the guide says what to do on a placeholder left in it.
    assert.match(text.replace(NOTE, ''), /not filled in: do not guess the value/);
  });
}

test('I5d: the handling guide has a successor section with every takeover step, and the outgoing thread passes what it needs', () => {
  const text = read(join(ROOT, TEMPLATES[0]));
  const section = text.slice(text.indexOf('## Taking over as successor'), text.indexOf('## Every notification'));
  assert.ok(section.length > 200, 'the section exists before the per-notification rules');
  for (const step of [/\*\*Read state\.\*\* .*status STATE --compact > \[\[private-config-dir\]\]\/t3-takeover\.json/, /never print it into this thread/, /\*\*Bind this thread\.\*\*/, /\*\*Update the private state file\*\*/, /\*\*Check the binding\.\*\* `CLI status STATE --inbox/, /`project\.session\.sessionId` must be this thread's ID/,
    /do not call `schedule_task`/, /TRIAGE --forwards --since <the handoff forward's time, from the summary>/, /whose `forwardTo` is not this thread's ID/, /\*\*Without a proxy:\*\* move the webhook/])
    assert.match(section, step);
  const handoff = text.slice(text.indexOf('- **Hand off to a fresh orchestrator session**'), text.indexOf('If now is the wrong moment'));
  assert.match(handoff, /the handoff question's inbox ID/);
  assert.match(handoff, /add the handoff forward's time and send ID/);
  assert.match(handoff, /follow the section "Taking over as successor"/);
});
