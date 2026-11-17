// Where an adopted installation lives inside its project repository.
//
// `adopt install --prefix tools/factotum` places VERSION, compatibility.json,
// factory/ and project/ under that folder instead of at the repository root.
// The adoption lock, factotum.lock.json, always stays at the repository root and
// records the prefix, so every later command (adopt update, upgrade apply,
// service install, doctor, generated command text) finds it there without being
// told again. No prefix (and no lock) means the repository root, as before.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockInHistory } from './verified-git.mjs';

export const LOCK = 'factotum.lock.json';
const fail = message => { throw new Error(message); };

// A prefix is a relative, already-normalised folder path inside the repository.
// '' (or undefined) is the repository root.
export function normalizePrefix(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') fail('invalid install prefix: must be a relative folder path');
  const text = value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value;
  if (text === '.') return '';
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) fail(`invalid install prefix ${JSON.stringify(value)}: must be relative to the repository root, not absolute`);
  if (/[\\\0-\x1f\x7f]/.test(text)) fail(`invalid install prefix ${JSON.stringify(value)}: backslashes and control characters are not allowed`);
  if (text.length > 200) fail('invalid install prefix: longer than 200 characters');
  const parts = text.split('/');
  if (parts.some(part => part === '' || part === '.')) fail(`invalid install prefix ${JSON.stringify(value)}: must be normalised (no empty or "." segments)`);
  if (parts.includes('..')) fail(`invalid install prefix ${JSON.stringify(value)}: ".." is not allowed; the installation must stay inside the repository`);
  if (parts.some(part => part.toLowerCase() === '.git')) fail(`invalid install prefix ${JSON.stringify(value)}: must not be inside .git`);
  // Printed commands and unit files interpolate it, so only plain path characters are allowed.
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part.startsWith('-'))) fail(`invalid install prefix ${JSON.stringify(value)}: each folder name may contain only letters, digits, ".", "_" and "-", and may not start with "-"`);
  return text;
}
// A release-relative path (factory/cli.mjs) as a repository-relative path.
export const underPrefix = (prefix, path) => prefix ? `${prefix}/${path}` : path;

// The project's adoption lock, or null when it has none. An unreadable or invalid lock is
// refused (fail closed): it decides where the upgrade-owned files are, so it is never guessed around.
// Absent means no lock only if the repository's history never had one: a deleted lock is
// treated as tampering, since it would silently move the protected core back to the root.
export function readInstallLock(root, { history = true } = {}) {
  const path = join(root, LOCK);
  let stat = null;
  try { stat = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') fail(`${LOCK} cannot be inspected (${error.code}); restore it from the adoption commit`); }
  if (!stat) {
    const deletedIn = history ? lockHistory(root) : null;
    if (deletedIn) fail(`${LOCK} is missing, but this repository's history has one (${deletedIn.slice(0, 12)} has it); a deleted adoption lock is treated as tampering; restore it from the adoption commit`);
    return null;
  }
  if (!stat.isFile()) fail(`${LOCK} is not a regular file (a symlink, folder or other file type); restore it from the adoption commit`);
  let lock;
  try { lock = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { fail(`${LOCK} is unreadable or not valid JSON (${error.code ?? 'parse error'}); restore it from the adoption commit`); }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) || lock.formatVersion !== 1) fail(`${LOCK} is not a valid adoption lock; restore it from the adoption commit`);
  if (Object.hasOwn(lock, 'prefix')) {
    let valid = false; try { valid = typeof lock.prefix === 'string' && !!lock.prefix && normalizePrefix(lock.prefix) === lock.prefix; } catch {}
    if (!valid) fail(`${LOCK} records an invalid install prefix (${JSON.stringify(lock.prefix)}); restore it from the adoption commit`);
  }
  return lock;
}
// A commit reachable from HEAD that has the lock, or null (also outside Git or before the first
// commit). Read through verified objects (core/verified-git.mjs); a repository with replace refs,
// grafts or a shallow history is refused rather than read.
export const lockHistory = root => lockInHistory(root, LOCK);
// The prefix recorded by the project's adoption lock; '' when there is no lock or it records none.
export const installPrefix = root => readInstallLock(root)?.prefix ?? '';
// Paths a builder may not change: the lock always (it decides where the core is and what an
// update may replace or remove), and, as upgrade-owned core, the factory folder and, once
// adopted, VERSION and compatibility.json under the prefix. dirs end in '/'.
export function upgradeOwned(root) {
  const lock = readInstallLock(root), prefix = lock?.prefix ?? '';
  return { prefix, lock: LOCK, dirs: [`${underPrefix(prefix, 'factory')}/`], files: lock ? ['VERSION', 'compatibility.json'].map(name => underPrefix(prefix, name)) : [] };
}
// Quote one shell word for printed commands; plain words stay as they are.
export const shellWord = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(value)) ? String(value) : `'${String(value).replace(/'/g, `'\\''`)}'`;
// The project's own CLI, as installed in its checkout.
export const factoryCli = root => join(root, installPrefix(root), 'factory', 'cli.mjs');
// The command an operator types from the repository root, for guidance text.
export const cliCommand = root => {
  let prefix = '';
  // Display only: no history lookup on every view.
  try { prefix = root ? readInstallLock(root, { history: false })?.prefix ?? '' : ''; } catch {}
  return `node ${underPrefix(prefix, 'factory/cli.mjs')}`;
};
