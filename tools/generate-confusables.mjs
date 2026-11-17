// Generates starter/factory/operations/upkeep-confusables.mjs, the trimmed confusables table the
// knowledge-upkeep text rules match against (docs/changes/upkeep-confusables.md).
//
//   node tools/generate-confusables.mjs <confusables.txt> [--check]
//
// The source is the Unicode confusables data for UTS #39, version 18.0.0:
//   https://www.unicode.org/Public/18.0.0/security/confusables.txt
// Download it yourself; this script fetches nothing, and it refuses any file whose SHA-256 is not
// the pinned one. --check compares the output with the committed table instead of writing it.
//
// The text rules match ASCII patterns, so the table keeps only what can change whether such a
// pattern matches. The rules read a text as: NFKC, NFKD, combining marks removed, each character
// replaced by its prototype, ASCII lowercased (operations/upkeep-assessment.mjs). A row's reading is
// its prototype read the same way: decomposed, marks removed, ASCII lowercased; any other character
// stays as it is, so a middle dot in a prototype ("b·") is punctuation, a gap inside a word. The
// table keeps a row when
//   - the source is unchanged by NFKD (any other source is decomposed or folded before the lookup
//     and never reaches the table) and is not a combining mark (marks are removed first); and
//   - the row can matter: its reading holds an ASCII letter (a look-alike of a letter, whatever else
//     the prototype holds) or a colon or equals sign (which the credential rule matches), or the
//     source is a letter and its reading holds no letter (a letter that looks like punctuation or a
//     digit, which then splits a word as punctuation does). A row that only turns one gap into
//     another (a fraction slash into a slash) cannot change a match and is left out.
// missingRows checks the result against the whole source: no row whose reading can matter may read
// differently, as the rules see it, with the trimmed table than with the full one. Generating and
// --check both run it.
// One change to the prototypes: the standard's prototype for m and its look-alikes is "rn", which
// would also read every ordinary "rn" as an m. The prototype "rn" is written "m" (and the row m → rn
// is then the identity and is left out), so a look-alike of m still reads as m.
// Which characters are letters, marks or decomposable is the runtime's knowledge (its Unicode
// version is written in the header). Regenerate under the same Unicode version to reproduce the table.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SOURCE = Object.freeze({ version: '18.0.0', url: 'https://www.unicode.org/Public/18.0.0/security/confusables.txt', sha256: '6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92' });
const OUTPUT = new URL('../starter/factory/operations/upkeep-confusables.mjs', import.meta.url);
const REWRITTEN = Object.freeze({ rn: 'm' });

const chars = field => String.fromCodePoint(...field.trim().split(/\s+/).map(hex => parseInt(hex, 16)));
const lowerAscii = text => text.replace(/[A-Z]+/gu, run => run.toLowerCase());
const MARK = /\p{M}/u, LETTER = /\p{L}/u;

export function parseRows(text) {
  return text.replace(/^\uFEFF/u, '').split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => {
    const [source, target, type] = line.split('#')[0].split(';');
    if (type?.trim() !== 'MA' || [...chars(source)].length !== 1) throw new Error(`unexpected row: ${line}`);
    return { source: chars(source), target: chars(target) };
  });
}
// A prototype as the table holds it: decomposed, marks removed, rn written m. It may be empty (a
// prototype of marks only, read as nothing).
function prototypeOf(target) {
  const read = target.normalize('NFKD').replace(/\p{M}/gu, '');
  return REWRITTEN[read] ?? read;
}
// How the rules read one character with a lookup: steps 1 to 3 of the reading.
export const readWith = (lookup, char) => lowerAscii([...char.normalize('NFKD')].filter(part => !MARK.test(part)).map(part => lookup(part) ?? part).join(''));
// What an ASCII rule can tell apart in a reading: ASCII letters, white space, and the two characters
// the rules match outside words (the colon and equals sign of a credential). Every other run of
// characters is a gap between letters, whatever it holds, and every letter outside ASCII is a letter
// no rule matches, whichever it is.
const ruleView = read => read.replace(/[^\p{L}\s:=]+/gu, '-').replace(/[^\x00-\x7f\s]/gu, '*');
// Whether reading a character as `read` can change whether an ASCII rule matches.
const matters = (source, read) => ruleView(read) !== ruleView(readWith(() => undefined, source)) && (/[a-z:=]/u.test(read) || LETTER.test(source) && !LETTER.test(read));

export function trimmedTable(text) {
  const rows = parseRows(text), table = new Map();
  for (const { source, target } of rows) {
    if (source.normalize('NFKD') !== source || MARK.test(source)) continue;
    const prototype = prototypeOf(target);
    if (prototype !== source && matters(source, lowerAscii(prototype))) table.set(source, prototype);
  }
  return { rows: rows.length, table };
}
// The sources whose reading can matter and which the table reads otherwise than the full source
// does. A correct table leaves none.
export function missingRows(text, table) {
  const rows = parseRows(text), full = new Map(rows.map(({ source, target }) => [source, prototypeOf(target)]));
  return rows.map(({ source }) => source).filter(source => { const read = readWith(char => full.get(char), source); return matters(source, read) && ruleView(readWith(char => table.get(char), source)) !== ruleView(read); });
}

// The module: one entry per prototype, its sources as escapes, sorted, so a change reads as a diff.
export function moduleText(table) {
  const byPrototype = new Map();
  for (const [source, prototype] of table) byPrototype.set(prototype, [...(byPrototype.get(prototype) ?? []), source]);
  const escape = char => { const code = char.codePointAt(0); return code < 0x7f && /[!-~]/u.test(char) && !`'\\`.includes(char) ? char : code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`; };
  const key = prototype => /^[A-Za-z][A-Za-z0-9]*$/u.test(prototype) ? prototype : `'${[...prototype].map(escape).join('')}'`;
  const lines = [...byPrototype].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([prototype, sources]) => `  ${key(prototype)}: '${sources.sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).map(escape).join('')}',`);
  return `// Generated by tools/generate-confusables.mjs; do not edit. See docs/changes/upkeep-confusables.md.
// Source: ${SOURCE.url}
// Unicode ${SOURCE.version}, SHA-256 ${SOURCE.sha256}; trimmed under the runtime's Unicode ${process.versions.unicode}
// Trimmed to the ${table.size} rows that can change whether an ASCII text rule matches. Each key is a
// prototype; its value holds every character the table reads as that prototype.
export const CONFUSABLES_SOURCE = Object.freeze({ version: '${SOURCE.version}', sha256: '${SOURCE.sha256}', rows: ${table.size} });
export const CONFUSABLE_PROTOTYPES = Object.freeze({
${lines.join('\n')}
});
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, flag] = process.argv.slice(2);
  if (!path) { console.error('usage: node tools/generate-confusables.mjs <confusables.txt> [--check]'); process.exit(2); }
  const bytes = readFileSync(path), digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== SOURCE.sha256) { console.error(`${path}: SHA-256 ${digest}, expected ${SOURCE.sha256} (Unicode ${SOURCE.version})`); process.exit(1); }
  const { rows, table } = trimmedTable(bytes.toString('utf8')), text = moduleText(table);
  const missing = missingRows(bytes.toString('utf8'), table);
  if (missing.length) { console.error(`the trimmed table reads ${missing.length} rows otherwise than the source: ${missing.slice(0, 20).map(char => `U+${char.codePointAt(0).toString(16).toUpperCase()}`).join(' ')}`); process.exit(1); }
  if (flag === '--check') {
    const same = readFileSync(OUTPUT, 'utf8') === text;
    console.log(same ? `up to date: ${table.size} of ${rows} rows; no row that can matter is dropped` : 'the committed table differs from the source'); process.exit(same ? 0 : 1);
  }
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT.pathname}: ${table.size} of ${rows} rows, ${Buffer.byteLength(text)} bytes`);
}
