import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';
import { stripControls } from './text.mjs';
import { redactSecretText } from './redact.mjs';

// Why a trusted command (a workflow effect with argv and no action) failed, readable without the
// state directory: how it ended and the last lines of its output. Command output is untrusted
// diagnostic data: control sequences are stripped, every secret value the factory knows (`secrets`,
// operations/known-secrets.mjs, with its encoded forms) and credential-like text are redacted, and the
// excerpt is bounded (TAIL_LINES lines and EXCERPT_CHARS characters per stream, read from at most
// TAIL_BYTES at the end of each log).
const TAIL_BYTES = 8192, TAIL_LINES = 12, EXCERPT_CHARS = 1200;

// The same bounded, redacted excerpt of output already in memory (a child process's stdout or
// stderr): the last TAIL_LINES lines and EXCERPT_CHARS characters of the last TAIL_BYTES. Redaction
// runs before the cut, so a cut cannot leave part of a secret. `cut` says the text's first line
// may be partial (the text is itself the end of a longer output).
export function outputExcerpt(output, secrets = [], { cut = false } = {}) {
  let raw = String(output ?? '');
  if (Buffer.byteLength(raw) > TAIL_BYTES) { raw = Buffer.from(raw).subarray(-TAIL_BYTES).toString('utf8'); cut = true; }
  let text = redactSecretText(stripControls(raw), secrets).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const lines = text.split('\n'); if (cut) lines.shift(); // the first line may be cut, and with it part of a secret
  text = lines.slice(-TAIL_LINES).join('\n');
  return text.length > EXCERPT_CHARS ? `…${text.slice(-(EXCERPT_CHARS - 1))}` : text;
}

function tail(path, secrets) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !stat.size) return '';
    const length = Math.min(stat.size, TAIL_BYTES), buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stat.size - length);
    return outputExcerpt(buffer.subarray(0, read).toString('utf8'), secrets, { cut: stat.size > length });
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}
// "stderr (last lines):\n…" and "stdout (last lines):\n…" for a failure notice; '' when both are empty.
export function excerptBlock({ stderr, stdout }) {
  return [stderr ? `stderr (last lines):\n${stderr}` : '', stdout ? `stdout (last lines):\n${stdout}` : ''].filter(Boolean).join('\n');
}

const ENDINGS = { timeout: 'was stopped after its timeout', 'output-limit': 'was stopped for writing more than 1 MiB of output', 'descendant-survival': 'left processes running after it exited' };
export function commandFailure(dir, receipt = {}, secrets = []) {
  const clean = text => redactSecretText(stripControls(text), secrets);
  const how = receipt.launchError ? `could not start (${clean(receipt.launchError).slice(0, 200)})`
    : ENDINGS[receipt.reason] ? `${ENDINGS[receipt.reason]}${receipt.exitCode !== null && receipt.exitCode !== undefined ? ` (exit code ${receipt.exitCode})` : receipt.signal ? ` (signal ${receipt.signal})` : ''}`
    : receipt.signal ? `was ended by signal ${receipt.signal}`
    : receipt.exitCode !== null && receipt.exitCode !== undefined ? `exited with code ${receipt.exitCode}`
    : `ended without an exit code${receipt.reason ? ` (${clean(receipt.reason).slice(0, 200)})` : ''}`;
  const stderr = tail(join(dir, 'stderr.log'), secrets), stdout = tail(join(dir, 'stdout.log'), secrets);
  return { exitCode: receipt.exitCode ?? null, signal: receipt.signal ?? null, ending: receipt.reason ? clean(receipt.reason).slice(0, 200) : null, summary: `the command ${how}`, ...(stderr ? { stderr } : {}), ...(stdout ? { stdout } : {}) };
}
// The attempt's operator-facing notice (core/engine.mjs attemptNotice): how it ended, then the excerpts.
export function commandFailureNotice(failure) {
  if (!failure) return '';
  const output = excerptBlock(failure);
  const summary = String(failure.summary ?? 'the command failed');
  return `${summary[0].toUpperCase()}${summary.slice(1)}.${output ? `\n${output}` : ' It wrote no output.'}`;
}
