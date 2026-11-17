// A line comparison of two texts, computed by the factory (knowledge-upkeep design, 6.3 and 7.4).
//
// It is used on blobs read through hash-verified objects, never through `git diff` under the
// repository's configuration, attributes or filters. Whitespace and line-ending changes count:
// lines are compared exactly. Pure: no Git, no store, no clock.
//
// The comparison trims the common head and tail and finds a longest common subsequence of what is
// left. When that middle is too large to compare cell by cell it is taken as removed and added
// whole, which never under-reports a change.
export const LINE_DIFF_CELLS = 4_000_000;
const lines = text => { const rows = String(text).split('\n'); if (rows.at(-1) === '') rows.pop(); return rows; };
// Every line with its terminator kept: 'a\n' and 'a' (a last line without a newline) differ, and so
// do 'a\r\n' and 'a\n'. A byte order mark stays part of the first line.
export const exactLines = text => String(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];

// [{ op: ' ' | '-' | '+', text, a, b }]: every line of both texts in order, with its 1-based line
// number in the old text (a) and in the new one (b); the side a line is not on is null.
export function lineDiff(before, after, { split = lines } = {}) {
  const old = split(before), next = split(after), rows = [];
  let head = 0; while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0; while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  for (let at = 0; at < head; at++) rows.push({ op: ' ', text: old[at], a: at + 1, b: at + 1 });
  const left = old.slice(head, old.length - tail), right = next.slice(head, next.length - tail);
  const removed = at => rows.push({ op: '-', text: left[at], a: head + at + 1, b: null }), added = at => rows.push({ op: '+', text: right[at], a: null, b: head + at + 1 });
  if (!left.length || !right.length || left.length * right.length > LINE_DIFF_CELLS) { left.forEach((_, at) => removed(at)); right.forEach((_, at) => added(at)); }
  else {
    // The length of the longest common subsequence of left[i..] and right[j..], one row at a time.
    const width = right.length + 1, table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { rows.push({ op: ' ', text: left[i], a: head + i + 1, b: head + j + 1 }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) removed(i++); else added(j++);
    }
    while (i < left.length) removed(i++); while (j < right.length) added(j++);
  }
  for (let at = 0; at < tail; at++) rows.push({ op: ' ', text: old[old.length - tail + at], a: old.length - tail + at + 1, b: next.length - tail + at + 1 });
  return rows;
}
// The added plus removed lines of the comparison.
export const changedLines = (before, after) => lineDiff(before, after).filter(row => row.op !== ' ').length;
// The same count with every terminator kept (exactLines): a changed or missing final newline, a
// changed line ending and a byte order mark each count as a changed line. The candidate budget of
// an upkeep task (knowledge-upkeep design, 7.4) counts this way.
export const changedLinesExact = (before, after) => lineDiff(before, after, { split: exactLines }).filter(row => row.op !== ' ').length;
// The changes with `context` unchanged lines either side, as hunks: [{ a, b, lines: ['-old', '+new', ' same'] }]
// where a and b are the first line of the hunk in the old and the new text.
export function diffHunks(before, after, context = 3) {
  const rows = lineDiff(before, after), keep = new Array(rows.length).fill(false), hunks = [];
  rows.forEach((row, at) => { if (row.op !== ' ') for (let near = Math.max(0, at - context); near <= Math.min(rows.length - 1, at + context); near++) keep[near] = true; });
  let open = null, a = 1, b = 1;
  rows.forEach((row, at) => {
    if (keep[at]) { if (!open) hunks.push(open = { a, b, lines: [] }); open.lines.push(`${row.op}${row.text}`); } else open = null;
    if (row.a !== null) a = row.a + 1; if (row.b !== null) b = row.b + 1;
  });
  return hunks;
}
