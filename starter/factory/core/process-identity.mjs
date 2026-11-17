import { readFileSync } from 'node:fs';
export function processIdentity(pid = process.pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}
export function sameProcess(identity) {
  try { const current = processIdentity(identity.pid); return current.bootId === identity.bootId && current.startTime === identity.startTime; }
  catch { return false; }
}
