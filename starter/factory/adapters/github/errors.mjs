import { stripVTControlCharacters } from 'node:util';
import { redactSecretText } from '../../core/redact.mjs';
import { stripControls } from '../../core/text.mjs';

// Never serialize request bodies, command arguments, environment or stdout (auth
// token lookup writes the credential to stdout). Retain bounded error evidence.
function diagnosticText(value, secrets = [], limit = 4096) {
  let text = stripControls(stripVTControlCharacters(String(value ?? '')));
  text = redactSecretText(text, secrets);
  const marker = '\n[truncated]\n', half = Math.floor((limit - marker.length) / 2);
  return text.length <= limit ? text : `${text.slice(0, half)}${marker}${text.slice(-half)}`;
}

export function cliFailureDetails(error, env = {}) {
  const secrets = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].map(key => env[key]);
  return {
    ...(typeof error.code === 'string' ? { code: diagnosticText(error.code, secrets, 128) } : Number.isInteger(error.code) ? { code: error.code } : {}),
    ...(typeof error.started === 'boolean' ? { started: error.started } : {}),
    ...(error.stderr ? { stderr: diagnosticText(error.stderr, secrets) } : {}),
  };
}

export class ForgeError extends Error {
  constructor(message, { status, kind = 'unknown', ambiguous = false, cause, reconciliationError, diagnostics } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ForgeError';
    Object.assign(this, { status, kind, ambiguous, ...(reconciliationError ? { reconciliationError } : {}), ...(diagnostics ? { diagnostics } : {}) });
  }
}

export function forgeErrorDetails(error, depth = 0) {
  if (!error || depth > 3) return undefined;
  return {
    message: diagnosticText(error.message, [], 1024),
    ...(error instanceof ForgeError ? { kind: error.kind, ambiguous: error.ambiguous, ...(error.status ? { status: error.status } : {}) } : {}),
    ...(typeof error.code === 'string' || Number.isInteger(error.code) ? { code: diagnosticText(error.code, [], 128) } : {}),
    ...(error instanceof ForgeError && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    ...(error.cause && depth < 3 ? { cause: forgeErrorDetails(error.cause, depth + 1) } : {}),
    ...(error.reconciliationError && depth < 3 ? { reconciliation: forgeErrorDetails(error.reconciliationError, depth + 1) } : {}),
  };
}

// The write remains uncertain even if its read-only reconciliation also fails.
// A fresh attempt must still look up the marker before writing again.
export async function reconcileWriteFailure(error, message, lookup) {
  let recovered, reconciliationError;
  try { recovered = await lookup(); } catch (failure) { reconciliationError = failure; }
  if (recovered) return recovered;
  const detail = diagnosticText(error.message, [], 512);
  throw new ForgeError(`${message}. Cause: ${detail}${reconciliationError ? '; reconciliation lookup also failed' : ''}`, { kind: 'uncertain', ambiguous: true, cause: error, reconciliationError });
}
