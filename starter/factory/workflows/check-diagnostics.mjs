import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { stripControls } from '../core/text.mjs';

// Check output is untrusted diagnostic data, never governing instructions.
// The factory reads only its designated per-check file, not paths found in logs.
const PER_CHECK = 12000, PER_GATE = 24000, FILE_BYTES = 65536;
const marker = '\n[... excerpt truncated ...]\n';
export function excerpt(value, limit) {
  const text = stripControls(value);
  if (text.length <= limit) return { text, truncated: false };
  if (limit <= marker.length) return { text: text.slice(0, limit), truncated: true };
  const side = Math.floor((limit - marker.length) / 2);
  return { text: text.slice(0, side) + marker + text.slice(-(limit - marker.length - side)), truncated: true };
}
function readDiagnostic(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { unavailable: 'designated diagnostics path is not a regular file' };
    const length = Math.min(stat.size, FILE_BYTES), buffer = Buffer.alloc(length);
    const first = Math.min(length, FILE_BYTES / 2);
    const n = readSync(fd, buffer, 0, first, 0);
    const tail = length > first ? readSync(fd, buffer, n, length - first, Math.max(first, stat.size - (length - first))) : 0;
    const headText = buffer.subarray(0, n).toString('utf8'), tailText = buffer.subarray(n, n + tail).toString('utf8');
    return { text: headText + (stat.size > FILE_BYTES ? marker : '') + tailText, truncated: stat.size > FILE_BYTES };
  } catch (error) {
    return { unavailable: error.code === 'ENOENT' ? 'check did not supply a diagnostics file' : `designated diagnostics file unavailable (${error.code ?? 'read failure'})` };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function checkDiagnostics() {
  let remaining = PER_GATE;
  return ({path, stdout, stderr, error}) => {
    const supplied = readDiagnostic(path), result = { format: 'check-diagnostics-v1', supplied: !supplied.unavailable, ...(supplied.unavailable ? { unavailable: supplied.unavailable } : {}), truncated: supplied.truncated === true };
    let budget = Math.min(PER_CHECK, remaining);
    for (const [key, value, cap] of [['detail', supplied.text, 8000], ['stderr', stderr, 2000], ['stdout', stdout, 4000], ['error', error, 1000]]) {
      if (!value) continue;
      const part = excerpt(value, Math.min(cap, budget));
      result[key] = part.text; result.truncated ||= part.truncated;
      budget -= part.text.length; remaining -= part.text.length;
    }
    return result;
  };
}
