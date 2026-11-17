// Measures what the knowledge-upkeep text rules refuse in ordinary prose (docs/changes/upkeep-confusables.md).
//
//   node tools/measure-text-rules.mjs [--module <path>] [--show] <file or directory>...
//
// Every Markdown, text or README file under the paths, and every manual page (.1 to .9, gzipped or
// not, its roff requests and font escapes removed), is cut into paragraphs at blank lines. Each
// paragraph of 20 characters or more, whitespace collapsed and cut to 1,500 characters (the longest
// text the rules judge), is given to textRules. Prints the paragraphs judged, the count refused for
// each reason and the count flagged for each flag; --show also prints each refused paragraph.
// --module names another copy of operations/upkeep-assessment.mjs to measure, such as an earlier one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2), show = args.includes('--show');
const at = args.indexOf('--module'), modulePath = at >= 0 ? args.splice(at, 2)[1] : new URL('../starter/factory/operations/upkeep-assessment.mjs', import.meta.url).pathname;
const paths = args.filter(arg => arg !== '--show');
const { textRules } = await import(pathToFileURL(resolve(modulePath)).href);

const PROSE = /(?:\.(?:md|markdown|txt|rst)|(?:^|\/)README[^/]*|(?:^|\/)NEWS[^/]*)$/iu, MANUAL = /\.[1-9][a-z]*(?:\.gz)?$/u;
const files = [];
const walk = path => { const stat = statSync(path, { throwIfNoEntry: false }); if (!stat) return; if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name)); } else if (stat.isFile() && (PROSE.test(path) || MANUAL.test(path))) files.push(path); };
for (const path of paths) walk(path);

const roff = text => text.split('\n').filter(line => !/^['.]\s*\\"/u.test(line)).map(line => /^[.']/u.test(line) ? (/^\.(?:SH|SS|TP|PP|P|LP|IP|sp|br)\b/u.test(line) ? '' : line.replace(/^\.[A-Za-z]+\s*/u, '')) : line).join('\n').replace(/\\f[BIRP]|\\f\[[^\]]*\]|\\[&|^]|\\\(..|\\-/gu, match => match === '\\-' ? '-' : '');
const totals = { files: files.length, paragraphs: 0, refused: {}, flagged: {} }, refusedTexts = [];
for (const file of files) {
  let text;
  try { const bytes = readFileSync(file); text = (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  if (MANUAL.test(file)) text = roff(text);
  for (const block of text.split(/\n\s*\n/u)) {
    const paragraph = block.replace(/\s+/gu, ' ').trim().slice(0, 1500);
    if (paragraph.length < 20) continue;
    totals.paragraphs++;
    const { refused, flags } = textRules(paragraph, 1500);
    if (refused) { totals.refused[refused] = (totals.refused[refused] ?? 0) + 1; refusedTexts.push({ file, refused, paragraph }); }
    for (const flag of flags) totals.flagged[flag] = (totals.flagged[flag] ?? 0) + 1;
  }
}
console.log(JSON.stringify(totals));
if (show) for (const row of refusedTexts) console.log(`${row.refused}\t${row.file}\t${row.paragraph}`);
