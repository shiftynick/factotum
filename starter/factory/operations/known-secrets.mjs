import { readFileSync } from 'node:fs';
import { scopedGitHubToken } from '../adapters/github/git.mjs';

// Every secret value this factory process knows, for removing verbatim from text it writes to
// disk: credential variables in its environment, the scoped GitHub token, every string under a
// secret-named key in the project configuration, and the notification delivery file's signing
// key and URL (the URL is a capability in itself) and its other secret-named values. These are
// known secrets, not guesses, so every non-empty value counts, however short.
//
// Each value is matched exactly, and also as it appears JSON-escaped, URL-encoded and in base64
// (standard and URL-safe, padded and unpadded). Base64 is matched only as the encoding of the value
// on its own. Not caught: a value split across lines (wrapped base64, for example), or encoded
// as part of longer data (embedded in a longer base64 run, at any offset, since the bytes around
// it change the encoding groups), or transformed any other way. Exact matching over-redacts on purpose: a configured secret that is an ordinary
// word replaces every occurrence of that word.
export const ENV_KEYS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'FACTOTUM_GIT_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
const SECRET_KEY = /token|secret|password|passphrase|credential|signing|api[-_]?key|private[-_]?key|authorization|cookie/i;
const known = value => typeof value === 'string' && value.length > 0;
function collect(value, out, secretKey = false) {
  if (typeof value === 'string') { if (secretKey && known(value)) out.add(value); return; }
  if (Array.isArray(value)) { for (const item of value) collect(item, out, secretKey); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(item, out, secretKey || SECRET_KEY.test(key));
}
// The forms a value commonly takes in text: raw, JSON-escaped, URL-encoded and base64.
export function secretForms(value) {
  const base64 = Buffer.from(value, 'utf8').toString('base64'), base64url = Buffer.from(value, 'utf8').toString('base64url');
  let urlEncoded = value; try { urlEncoded = encodeURIComponent(value); } catch { /* lone surrogate: no URL-encoded form */ }
  return [...new Set([value, JSON.stringify(value).slice(1, -1), urlEncoded, base64, base64.replace(/=+$/, ''), base64url])].filter(known);
}
export function knownSecrets(config = {}, env = process.env) {
  const out = new Set();
  for (const key of ENV_KEYS) if (known(env[key])) out.add(env[key]);
  const token = scopedGitHubToken(); if (known(token)) out.add(token);
  collect(config, out);
  const path = config?.notifications?.configPath;
  if (typeof path === 'string' && path) {
    try {
      const delivery = JSON.parse(readFileSync(path, 'utf8'));
      collect(delivery, out);
      for (const key of ['signingKey', 'url']) if (known(delivery?.[key])) out.add(delivery[key]);
    } catch { /* No readable delivery file: nothing of it can be known here. */ }
  }
  return [...new Set([...out].flatMap(secretForms))];
}
