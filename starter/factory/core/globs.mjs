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
//   extended   also `[abc]`, `[a-z]` and `[!abc]` (one character other than '/'), `{a,b}` (either
//              alternative; alternatives may hold wildcards and nest) and `\x` (x literally).
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
function classEnd(glob, at) {
  let i = at + 1;
  if (glob[i] === '!' || glob[i] === '^') i++;
  if (glob[i] === ']') i++;
  for (; i < glob.length; i++) if (glob[i] === ']') return i;
  return -1;
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
    else if (extended && char === '[' && classEnd(glob, at) > 0) {
      const end = classEnd(glob, at), negated = glob[at + 1] === '!' || glob[at + 1] === '^';
      const body = glob.slice(at + (negated ? 2 : 1), end).replace(/[\\\]^[]/g, '\\$&');
      out += negated ? `[^/${body}]` : `(?!/)[${body}]`;
      at = end;
    } else if (extended && char === '{' && closing(glob, at, '{', '}') > 0) {
      const end = closing(glob, at, '{', '}'), parts = alternatives(glob.slice(at + 1, end));
      if (parts.length < 2) { out += literal(char); continue; }
      out += `(?:${parts.map(part => source(part, extended)).join('|')})`;
      at = end;
    } else out += literal(char);
  }
  return out;
}

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
