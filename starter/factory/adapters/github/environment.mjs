import { accessSync, constants, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
// Applied to API invocations and credential lookups alike. No interactive helpers
// or background update/telemetry senders belong to a supervised factory action.
export function quietGitHubEnvironment(source){
 const env={...source};delete env.GH_FORCE_TTY;
 return {...env,GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1',GH_TELEMETRY:'0',DO_NOT_TRACK:'1',GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',PAGER:'cat',NO_COLOR:'1',CLICOLOR:'0',CLICOLOR_FORCE:'0'};
}

// Which gh a factory call would run, and whether it is the real binary. A shim
// or wrapper script can do version-manager work (and fork) before exec'ing gh.
export function inspectGhBinary({ ghPath, path = process.env.PATH ?? '' } = {}) {
  const candidates = ghPath ? [ghPath] : path.split(delimiter).filter(isAbsolute).map(dir => join(dir, 'gh'));
  const found = candidates.find(file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
  if (!found) return { path: null, problems: [ghPath ? `repository.ghPath ${ghPath} is not an executable file` : 'gh was not found on PATH'] };
  const real = realpathSync(found), header = Buffer.alloc(4), fd = openSync(real, 'r');
  try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
  const problems = [];
  if (header.toString('latin1') !== '\x7fELF') problems.push(`${found} is a script wrapper, not the gh binary`);
  else if (basename(real) !== 'gh' || /\/shims?\//.test(found)) problems.push(`${found} is a version-manager shim (${real}), not the gh binary`);
  return { path: found, realPath: real, pinned: Boolean(ghPath), problems };
}
