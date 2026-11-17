// Credential-shaped text removed before text is kept at rest or shown. A bounded set of
// patterns, not a secret scanner: it catches the tokens and assignments the factory itself
// handles (GitHub and provider credentials, bearer and basic headers, URL userinfo).
export function redactSecretText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b((?:GH|GITHUB|GH_ENTERPRISE|GITHUB_ENTERPRISE)_TOKEN|(?:OPENAI|ANTHROPIC|CODEX)_API_KEY|access_token|refresh_token|api_key|authorization|password|secret)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}
// redactSecretText over a whole recorded value: every string in it, and every object key, so a
// known secret that reached a field by any route (a model name, a route, a path, a command) is
// removed from the complete record before it is stored, printed or sent.
export function redactSecretValues(value, secrets = []) {
  if (typeof value === 'string') return redactSecretText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactSecretValues(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecretText(key, secrets), redactSecretValues(item, secrets)]));
  return value;
}
