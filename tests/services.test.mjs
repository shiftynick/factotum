import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleUnit, installUnit, projectUnit, uninstallUnit, unitDiagnostics, unitName } from '../starter/factory/operations/services.mjs';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'fct-units-')), root = join(base, 'project with space'), stateDir = join(base, 'state'), unitDir = join(base, 'units');
  mkdirSync(join(root, 'factory'), { recursive: true }); writeFileSync(join(root, 'factory/cli.mjs'), '');
  const calls = [], run = async (binary, args) => { if (binary === 'loginctl') return { code: 0, stdout: 'yes\n', stderr: '' }; calls.push([binary, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; };
  return { base, root, stateDir, unitDir, calls, run, project: { projectId: 'abcdef1234567890', name: 'Fictional', root } };
}

test('project units start the adopted checkout CLI, via launch when an installation root is given', () => {
  const f = setup();
  const served = projectUnit({ project: f.project, stateDir: f.stateDir, path: '/usr/bin:/bin' });
  assert.equal(served.name, 'factotum-project-abcdef12.service');
  assert.match(served.content, new RegExp(`ExecStart=\\S+ "${join(f.root, 'factory/cli.mjs')}" serve --state ${f.stateDir}`));
  assert.match(served.content, /Restart=on-failure/); assert.match(served.content, /WantedBy=default.target/);
  const launched = projectUnit({ project: f.project, stateDir: f.stateDir, installRoot: join(f.base, 'install') });
  assert.match(launched.content, / launch --state \S+ --install \S+install/);
  assert.throws(() => projectUnit({ project: { ...f.project, root: join(f.base, 'missing') }, stateDir: f.stateDir }), /existing absolute CLI/);
});

test('install writes, reloads and enables; a different existing unit needs --replace; uninstall removes only its own units', async t => {
  const f = setup(), unit = projectUnit({ project: f.project, stateDir: f.stateDir });
  const installed = await installUnit(unit, { unitDir: f.unitDir, run: f.run });
  assert.equal(installed.changed, true); assert.equal(installed.linger, 'enabled');
  assert.deepEqual(f.calls, ['systemctl --user daemon-reload', `systemctl --user enable --now ${unit.name}`]);
  assert.equal((await installUnit(unit, { unitDir: f.unitDir, run: f.run })).changed, false);
  const moved = projectUnit({ project: f.project, stateDir: join(f.base, 'other-state') });
  await assert.rejects(installUnit(moved, { unitDir: f.unitDir, run: f.run }), /pass --replace/);
  assert.equal((await installUnit(moved, { unitDir: f.unitDir, run: f.run, replace: true, start: false })).changed, true);
  assert.equal(f.calls.at(-1), `systemctl --user enable ${unit.name}`);
  writeFileSync(join(f.unitDir, 'factotum-console.service'), '[Unit]\nDescription=hand written\n');
  await assert.rejects(uninstallUnit('factotum-console.service', { unitDir: f.unitDir, run: f.run }), /not written by factotum/);
  await uninstallUnit(unit.name, { unitDir: f.unitDir, run: f.run });
  assert.equal(existsSync(join(f.unitDir, unit.name)), false);
  assert.ok(f.calls.includes(`systemctl --user disable --now ${unit.name}`));
});

test('doctor reports an installed unit that points elsewhere', async () => {
  const f = setup();
  assert.deepEqual(unitDiagnostics(f.project, f.stateDir, { unitDir: f.unitDir }), []);
  await installUnit(projectUnit({ project: f.project, stateDir: f.stateDir }), { unitDir: f.unitDir, run: f.run });
  assert.deepEqual(unitDiagnostics(f.project, f.stateDir, { unitDir: f.unitDir }), []);
  assert.match(unitDiagnostics(f.project, join(f.base, 'elsewhere'), { unitDir: f.unitDir })[0], /different state directory/);
  const consoleState = join(f.base, 'console'); mkdirSync(consoleState);
  assert.match(consoleUnit({ cli: join(f.root, 'factory/cli.mjs'), consoleState, port: 8787 }).content, /console --state \S+console --port 8787/);
  assert.equal(unitName('console'), 'factotum-console.service');
});
