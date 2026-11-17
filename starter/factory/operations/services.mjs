import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assert } from '../core/contracts.mjs';
import { factoryCli } from '../core/install-layout.mjs';
import { runProcess } from '../adapters/providers/index.mjs';

// Persistent systemd --user units for a project service and the shared console.
// The project unit starts the CLI from the adopted checkout, which follows
// adopt updates; with an installation root it uses `launch`, which resolves the
// active verified installation at every start.
export const defaultUnitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
const quote = value => {
  assert(typeof value === 'string' && value && !/[\n\r\0]/.test(value), 'unit arguments must be single-line strings');
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, char => `\\${char}`).replace(/%/g, '%%')}"`;
};
// A unit outlives this shell: keep only existing absolute PATH entries outside
// temporary directories (e.g. an app image mount).
export const stablePath = (path = '') => path.split(':').filter(entry => isAbsolute(entry) && existsSync(entry) && !entry.startsWith(tmpdir() + '/') && !entry.startsWith('/tmp/')).join(':');
const literal = value => { assert(typeof value === 'string' && value && !/[\n\r\0]/.test(value), 'unit values must be single-line strings'); return value.replace(/%/g, '%%'); };
export const unitName = (kind, projectId) => kind === 'console' ? 'factotum-console.service' : `factotum-project-${projectId.slice(0, 8)}.service`;

export function renderUnit({ kind, name, cli, args, workingDirectory, path }) {
  assert(isAbsolute(cli) && existsSync(cli), 'the unit needs an existing absolute CLI path');
  return [
    '# Written by factotum service install. Reinstall rather than editing by hand.',
    '[Unit]', `Description=Factotum ${kind === 'console' ? 'shared console' : `project service (${name})`}`, 'After=network-online.target', 'Wants=network-online.target', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${literal(workingDirectory)}`, `Environment=${quote(`PATH=${stablePath(path)}`)}`,
    `ExecStart=${[process.execPath, cli, ...args].map(quote).join(' ')}`,
    'Restart=on-failure', 'RestartSec=10', 'KillMode=mixed', 'TimeoutStopSec=60', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

export function projectUnit({ project, stateDir, installRoot, socketPath, path = process.env.PATH }) {
  // The adopted checkout's CLI, under the install prefix recorded in its factotum.lock.json.
  const cli = factoryCli(project.root);
  const args = installRoot ? ['launch', '--state', resolve(stateDir), '--install', resolve(installRoot)] : ['serve', '--state', resolve(stateDir)];
  if (socketPath) args.push('--socket', resolve(socketPath));
  return { name: unitName('project', project.projectId), content: renderUnit({ kind: 'project', name: project.name, cli, args, workingDirectory: project.root, path }) };
}
export function consoleUnit({ cli, consoleState, port = '0', path = process.env.PATH }) {
  assert(/^\d+$/.test(String(port)), 'console port must be a number');
  return { name: unitName('console'), content: renderUnit({ kind: 'console', cli: resolve(cli), args: ['console', '--state', resolve(consoleState), '--port', String(port)], workingDirectory: resolve(consoleState), path }) };
}

// Write (or confirm) the unit, then reload and enable it. A different existing
// unit is replaced only with replace:true.
export async function installUnit(unit, { unitDir = defaultUnitDir(), replace = false, start = true, run = runProcess } = {}) {
  const target = join(unitDir, unit.name), existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  assert(existing === null || existing === unit.content || replace, `${target} already exists with different content; inspect it or pass --replace`);
  mkdirSync(unitDir, { recursive: true });
  if (existing !== unit.content) writeFileSync(target, unit.content, { mode: 0o644 });
  await systemctl(run, ['daemon-reload']);
  await systemctl(run, ['enable', ...(start ? ['--now'] : []), unit.name]);
  return { unit: unit.name, path: target, changed: existing !== unit.content, started: start, linger: await lingerStatus(run) };
}
export async function unitActive(name, { run = runProcess } = {}) {
  return (await run('systemctl', ['--user', 'is-active', '--quiet', name], { env: process.env, timeoutMs: 10000 })).code === 0;
}
// Whether a unit runs code from this project checkout (a shared console may run from another).
export async function unitRunsFrom(name, root, { run = runProcess } = {}) {
  const result = await run('systemctl', ['--user', 'show', '-p', 'ExecStart', '--value', name], { env: process.env, timeoutMs: 10000 });
  return result.code === 0 && String(result.stdout ?? '').includes(root);
}
export const startUnit = (name, { run = runProcess } = {}) => systemctl(run, ['start', name]);
export const stopUnit = (name, { run = runProcess } = {}) => systemctl(run, ['stop', name]);
export async function uninstallUnit(name, { unitDir = defaultUnitDir(), run = runProcess } = {}) {
  const target = join(unitDir, name);
  assert(existsSync(target), `${target} is not installed`);
  assert(readFileSync(target, 'utf8').startsWith('# Written by factotum service install.'), `${target} was not written by factotum service install`);
  await systemctl(run, ['disable', '--now', name]);
  rmSync(target); await systemctl(run, ['daemon-reload']);
  return { unit: name, removed: target };
}
// Whether user units start at boot without a login session.
async function lingerStatus(run) {
  const user = process.env.USER || process.env.LOGNAME;
  const result = user ? await run('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { env: process.env, timeoutMs: 10000 }).catch(() => null) : null;
  const value = result?.code === 0 ? result.stdout.trim() : null;
  return value === 'yes' ? 'enabled' : value === 'no' ? 'disabled: units start at login only. To start them at boot, run once: loginctl enable-linger $USER' : 'unknown: check with loginctl show-user $USER -p Linger';
}
async function systemctl(run, args) {
  const result = await run('systemctl', ['--user', ...args], { env: process.env, timeoutMs: 60000 });
  assert(result.code === 0, `systemctl --user ${args.join(' ')} failed: ${(result.stderr ?? '').trim().slice(0, 400)}`);
}

// Doctor: an installed project unit must still point at this state and an existing CLI.
export function unitDiagnostics(project, stateDir, { unitDir = defaultUnitDir() } = {}) {
  const target = join(unitDir, unitName('project', project.projectId));
  if (!existsSync(target)) return [];
  const exec = readFileSync(target, 'utf8').split('\n').find(line => line.startsWith('ExecStart=')) ?? '';
  const reasons = [];
  let cli;
  try { cli = factoryCli(project.root); } catch (error) { return [`${target} cannot be checked: ${error.message}`]; }
  if (!exec.includes(cli) || !existsSync(cli)) reasons.push(`${target} does not start this project's ${relative(project.root, cli)}; reinstall it with service install`);
  if (!exec.includes(resolve(stateDir))) reasons.push(`${target} points at a different state directory; reinstall it with service install`);
  return reasons;
}
