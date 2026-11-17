// Relative path globs: the one matcher for globs an operator or project supplies (knowledge
// upkeep's docs and learnings scopes, cleanup.excludeIgnored). Paths are relative, separated by
// '/', and matched exactly in letter case.
//   *   any run of characters inside one path segment
//   ?   one character inside one path segment
//   **  any run of characters across segments; `**/` also matches no directory at all, so
//       docs/**/*.md covers docs/a.md and docs/guide/a.md
// A segment starting with a dot is matched like any other: node_modules/** covers
// node_modules/.pnpm/x. (Node's path.matchesGlob never lets a wildcard match a dot segment, which
// is why the factory does not use it for these globs.)
// Options:
//   extended   also `[abc]`, `[a-z]`, `[a\-z]` and `[!abc]` (one character other than '/'; see
//              bracket()), `{a,b}` (either alternative; alternatives may hold wildcards and nest)
//              and `\x` (x literally).
//              Without it these characters are literal.
//   directory  a glob ending in `/**` also matches the directory itself: node_modules/** matches
//              node_modules, and **/node_modules/** matches apps/web/node_modules.
const ESCAPE = /[.+^${}()|[\]\\*?]/g;
const literal = text => text.replace(ESCAPE, '\\$&');

function closing(glob, at, open, close) {
  for (let depth = 0, i = at; i < glob.length; i++) {
    if (glob[i] === '\\') { i++; continue; }
    if (glob[i] === open) depth++;
    else if (glob[i] === close && --depth === 0) return i;
  }
  return -1;
}
function alternatives(body) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; }
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  return [...parts, body.slice(start)];
}
// A bracket class at glob[at] === '['. Returns { end, source }, or null when no ']' closes it (the
// '[' is then literal). A leading '!' or '^' negates it; a ']' first in it is literal; '\x' is x
// literally; 'a-b' is a range between two characters, and an unescaped '-' first or last is
// literal. It never matches '/'. POSIX classes such as [:alpha:] and characters outside the Basic
// Multilingual Plane are not supported, and neither is a reversed range: those throw, so a glob never
// matches more than this says.
function bracket(glob, at) {
  let i = at + 1;
  const negated = glob[i] === '!' || glob[i] === '^';
  if (negated) i++;
  const tokens = [];
  for (let first = true; ; first = false) {
    if (i >= glob.length) return null;
    if (glob[i] === ']' && !first) break;
    if (glob[i] === '[' && [':', '=', '.'].includes(glob[i + 1])) throw new Error(`unsupported glob syntax in ${glob}: POSIX classes such as [:alpha:] are not supported`);
    const escaped = glob[i] === '\\';
    if (escaped && i + 1 >= glob.length) return null;
    const code = glob.codePointAt(escaped ? i + 1 : i);
    if (code > 0xffff) throw new Error(`unsupported glob syntax in ${glob}: a character class may hold only characters of the Basic Multilingual Plane`);
    tokens.push({ code, escaped });
    i += escaped ? 2 : 1;
  }
  const hex = code => `\\u${code.toString(16).padStart(4, '0')}`;
  let body = '';
  for (let k = 0; k < tokens.length; k++) {
    const dash = tokens[k + 1];
    if (dash && dash.code === 0x2d && !dash.escaped && k + 2 < tokens.length) {
      const low = tokens[k].code, high = tokens[k + 2].code;
      if (low > high) throw new Error(`unsupported glob syntax in ${glob}: the range ${String.fromCodePoint(low)}-${String.fromCodePoint(high)} is reversed`);
      body += `${hex(low)}-${hex(high)}`; k += 2;
    } else body += hex(tokens[k].code);
  }
  return { end: i, source: negated ? `[^/${body}]` : `(?!/)[${body}]` };
}

function source(glob, extended) {
  let out = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '*') {
      if (glob[at + 1] === '*') { at++; if (glob[at + 1] === '/') { at++; out += '(?:.*/)?'; } else out += '.*'; }
      else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (extended && char === '\\' && at + 1 < glob.length) out += literal(glob[++at]);
    else if (extended && char === '[' && bracket(glob, at)) { const { end, source: part } = bracket(glob, at); out += part; at = end; }
    else if (extended && char === '{' && closing(glob, at, '{', '}') > 0) {
      const end = closing(glob, at, '{', '}'), parts = alternatives(glob.slice(at + 1, end));
      if (parts.length < 2) { out += literal(char); continue; }
      out += `(?:${parts.map(part => source(part, extended)).join('|')})`;
      at = end;
    } else out += literal(char);
  }
  return out;
}

// Throws when the glob uses syntax the matcher does not support; configuration validation calls it.
export function assertGlob(glob, { extended = false } = {}) { globToRegExp(glob, { extended }); }
export function globToRegExp(glob, { extended = false } = {}) {
  return new RegExp(`^${source(glob, extended)}$`, 's');
}
const compiled = new Map();
export function matchesGlob(glob, path, { extended = false, directory = false } = {}) {
  const key = `${extended ? 'x' : '-'}\0${glob}`;
  let pattern = compiled.get(key);
  if (!pattern) compiled.set(key, pattern = globToRegExp(glob, { extended }));
  if (pattern.test(path)) return true;
  return directory && glob.endsWith('/**') && glob.length > 3 && matchesGlob(glob.slice(0, -3), path, { extended, directory });
}
