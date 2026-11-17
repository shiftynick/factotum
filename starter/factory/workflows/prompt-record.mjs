import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../core/redact.mjs';

export const PROMPT_FILE = 'prompt.txt';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Keep the exact prompt a provider is given, next to its trace in the attempt's private
// artifact directory (0700 directory, 0600 file), before the provider starts. Every secret value
// the factory knows (`secrets`, see operations/known-secrets.mjs) and credential-shaped text are
// replaced first; promptDigest is the SHA-256 of the prompt as sent, so it matches
// `sha256sum prompt.txt` unless promptRedacted says something was replaced.
export function recordPrompt(dir, prompt, secrets = []) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const kept = redactSecretText(prompt, secrets), path = join(dir, PROMPT_FILE);
  writeFileSync(path, kept, { mode: 0o600 }); chmodSync(path, 0o600);
  return { promptDigest: sha256(prompt), ...(kept !== prompt ? { promptRedacted: true } : {}) };
}
