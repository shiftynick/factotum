import { execFileSync, spawnSync } from 'node:child_process';
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS, retryRefLockedFetchSync } from '../core/git-options.mjs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert } from '../core/contracts.mjs';
import { Store } from '../core/store.mjs';
import { backupProject } from '../core/backup.mjs';
import { adoptionStatus, authenticateLandedLock, cleanupAdoption, prepareAdoption, readRelease } from '../distribution.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { startUnit, stopUnit, unitActive, unitName, unitRunsFrom } from './services.mjs';
import { factoryCli, LOCK, shellWord } from '../core/install-layout.mjs';
import { readAnchor, recordAuthentication } from '../core/adoption-anchor.mjs';
import { NO_HISTORY_REWRITES_ARGS, NO_HISTORY_REWRITES_ENV, assertNoHistoryRewrites } from '../core/verified-git.mjs';
import { blocksDrain } from '../core/project.mjs';
import { inlineForRelease, readsSeparateIntents } from './state-layout.mjs';
import { INTENT_KIND } from '../core/records.mjs';
import { doctorTimeBound } from '../workflows/commission.mjs';
import { knownSecrets } from './known-secrets.mjs';
import { outputExcerpt } from '../core/command-failure.mjs';
import { redactSecretValues } from '../core/redact.mjs';

// A release that does not declare this release's record layout reads attempt intents only
// inline (operations/state-layout.mjs). Before its code replaces this one, the state is
// returned to that layout, with the runner stopped and before the backup, so that the backup
// too is one that release can use. A release that reads the layout needs no step.
const needsInlineLayout = (stateDir, compatibility) => { const store = new Store(stateDir); try { return !readsSeparateIntents(compatibility) && (store.layout().separate || store.count(INTENT_KIND) > 0); } finally { store.close(); } };
function inlineLayoutForRelease(stateDir, compatibility) {
  const store = new Store(stateDir);
  try { const result = inlineForRelease(store, compatibility); return { inlinedIntents: result?.restoredIntents ?? 0, reason: 'the target release reads attempt intents only inline' }; }
  finally { store.close(); }
}
const readCompatibility = text => { try { return JSON.parse(text); } catch { return null; } };

// The factory CLI steps upgrade apply runs with the merged code (dev.85). Each has its own limit:
// `config update --current` recompiles and records the configuration and waits on nothing, so ten
// minutes is ample; doctor gets doctorTimeBound (its permit wait, every provider probe with its
// retry, every main check, and a margin; capped), so the upgrade never cuts doctor off inside
// doctor's own bounds. A step that fails says which step, the command, how long it ran against its
// limit, the last thing doctor reported doing (its "doctor: [<phase>] <detail>" progress lines), its
// reasons when it printed them, and the last lines of its stdout and stderr, bounded and redacted
// with the factory's known secrets (core/command-failure.mjs outputExcerpt, as for G19).
export const CONFIG_UPDATE_TIMEOUT_MS = 600_000;
const PROGRESS_LINE = /^doctor: \[([^\]\n]+)\] ?(.*)$/;
export function lastDoctorProgress(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map(line => PROGRESS_LINE.exec(line)).filter(Boolean);
  const last = lines.at(-1);
  return last ? { phase: last[1], detail: last[2] } : null;
}
const secondsText = ms => `${Math.round(ms / 1000)} s`;
async function cliStep(cli, { name, args, command, timeoutMs, secrets }) {
  const started = Date.now();
  let result, failure;
  try { result = await cli(args, { timeoutMs }); } catch (error) { failure = error; }
  const elapsedMs = Date.now() - started, stdout = String(result?.stdout ?? failure?.stdout ?? ''), stderr = String(result?.stderr ?? failure?.stderr ?? '');
  // A step that succeeded still passes on its warnings (doctor's), so the upgrade result shows them.
  if (!failure && result?.code === 0) { let warnings = []; try { const out = JSON.parse(stdout); if (Array.isArray(out?.warnings)) warnings = out.warnings.map(w => outputExcerpt(String(w), secrets)); } catch { /* not JSON */ } return { ok: true, ...(warnings.length ? { warnings } : {}) }; }
  const progress = lastDoctorProgress(stderr), clean = text => outputExcerpt(text, secrets);
  const parsed = (() => { try { return JSON.parse(stdout); } catch { return null; } })(), reasons = Array.isArray(parsed?.reasons) ? parsed.reasons.map(reason => clean(String(reason))) : null;
  const where = progress ? ` during ${clean(progress.phase)}${progress.detail ? ` (${clean(progress.detail)})` : ''}` : ' before it reported any progress';
  const timedOut = failure?.code === 'TIMEOUT';
  const how = failure ? (timedOut ? `timed out after ${secondsText(elapsedMs)} (its limit is ${secondsText(timeoutMs)})${where}` : `did not complete: ${clean(failure.message ?? String(failure))} after ${secondsText(elapsedMs)}${where}`)
    : `exited with code ${result?.code} after ${secondsText(elapsedMs)}${reasons?.length ? `: ${reasons.join('; ')}` : (clean(stderr) || clean(stdout)) ? `: ${(clean(stderr) || clean(stdout)).split('\n').slice(-3).join(' / ')}` : ''}`;
  const out = clean(stdout), err = clean(stderr);
  return { ok: false, error: `the ${name} step (${command}) ${how}`, command, limitMs: timeoutMs, elapsedMs, ...(timedOut ? { timedOut: true } : {}), ...(result ? { exitCode: result.code ?? null } : {}),
    ...(progress ? { phase: clean(progress.phase), lastProgress: clean(`${progress.phase}${progress.detail ? `: ${progress.detail}` : ''}`) } : {}), ...(reasons ? { reasons } : {}), ...(out ? { stdout: out } : {}), ...(err ? { stderr: err } : {}) };
}
// The merged project's CLI, run as a child with the step's limit (runCli replaces it in tests and
// receives the same limit).
const cliRunner = (root, run, runCli) => (args, { timeoutMs }) => runCli ? runCli(args, { timeoutMs })
  : run(process.execPath, [factoryCli(root), ...args], { cwd: root, env: process.env, timeoutMs, label: `factory CLI ${args[0]}${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''}` });
// Each step records ok and durationMs; a failing step stops the sequence. A step that throws an
// error carrying `detail` records that detail with its message. Every recorded row is redacted
// whole with the known secrets (commands, paths, messages and excerpts alike).
const stepRecorder = (steps, secrets) => {
  const record = row => steps.push(redactSecretValues(row, secrets));
  const step = async (name, fn) => {
    const started = Date.now();
    try { const detail = await fn() ?? {}; record({ step: name, ok: detail.ok ?? true, durationMs: Date.now() - started, ...detail }); return detail; }
    catch (error) { record({ step: name, durationMs: Date.now() - started, ...(error.detail ?? {}), ok: false, error: error.message }); throw error; }
  };
  return Object.assign(step, { record });
};
const upgradeSecrets = config => { try { return knownSecrets(config); } catch { return knownSecrets({}); } };
// Which units to bring back, and when (dev.85 review). The project runner stays stopped until doctor
// has ended: a running project service advances a carried-over task flow as soon as its question is
// answered, whatever the admission pause or commissioning say, so starting it earlier would run
// flow work on code doctor has not qualified. A console that runs from this checkout is restarted
// right after recommissioning instead: by then config update has cleared commissioning, so the
// console refuses flow.start ("project doctor qualification required") and admission stays held,
// which is the state a shared console is already in during an upgrade. Anything not yet restarted
// comes back at the end, whatever happened.
function unitRestarts({ step, run, stopped, consoleUnit }) {
  const started = new Set();
  const start = name => { started.add(name); return step('start', async () => { await startUnit(name, { run }); return { unit: name }; }).catch(() => {}); };
  return {
    afterRecommission: async () => { for (const name of stopped.filter(name => name === consoleUnit && !started.has(name))) await start(name); },
    rest: async () => { for (const name of stopped.filter(name => !started.has(name))) await start(name); },
  };
}
// Recommission and doctor with the newly merged CLI, as two recorded steps.
async function recommissionAndDoctor({ step, cli, cliPath, stateDir, secrets, actor, onBehalfOf, note, afterRecommission }) {
  const state = resolve(stateDir);
  const show = args => `node ${cliPath} ${args.join(' ')}`;
  await step('recommission', async () => {
    const args = ['config', 'update', '--state', state, '--current', '--actor', actor, ...(onBehalfOf ? ['--instruction', onBehalfOf.instruction, ...(onBehalfOf.reference ? ['--reference', onBehalfOf.reference] : [])] : []), '--note', note];
    const outcome = await cliStep(cli, { name: 'recommission', args, command: show(['config', 'update', '--state', state, '--current']), timeoutMs: CONFIG_UPDATE_TIMEOUT_MS, secrets });
    // The message leads with what config update said (its last output lines), then the step's account.
    const said = (outcome.stderr || outcome.stdout || '').split('\n').slice(-3).join(' / ');
    if (!outcome.ok) throw Object.assign(new Error(`config update failed: ${said ? `${said} (${outcome.error})` : outcome.error}`), { detail: outcome });
  });
  await afterRecommission?.();
  await step('doctor', async () => {
    const bound = doctorTimeBound(stateDir), args = ['doctor', '--state', state];
    const outcome = await cliStep(cli, { name: 'doctor', args, command: show(args), timeoutMs: bound.timeoutMs, secrets });
    return { ...outcome, ready: outcome.ok, limitMs: bound.timeoutMs, ...(bound.capped ? { limitCapped: true } : {}) };
  });
}

// One guided path for adopting a release into a drained project.
// Without merge: verify drained, then prepare the review worktree and stop.
// With merge (after the review commit): stop units, back up, fast-forward,
// optionally push, clean up, recommission and doctor with the new code, restart.
// Replacement objects, grafts and the commit-graph cache are off: a builder could have planted them in
// the shared Git directory to change what a fast-forward or ancestry check sees.
const git = (cwd, args) => retryRefLockedFetchSync(args, () => execFileSync('git', [...NO_AUTO_MAINTENANCE, ...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...NO_HISTORY_REWRITES_ARGS, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { ...process.env, ...NO_HISTORY_REWRITES_ENV } }).trim());
// Obligations that gate further action on uncertain or retained state block a
// drain. Ordinary follow-ups, such as a human post-merge step, carry over.
export const blockingObligation = row => !['passed', 'failed', 'deferred'].includes(row.status) && row.requiresAuthorization === true;
export const carriedObligations = store => store.live('obligation').filter(row => !['passed', 'failed', 'deferred'].includes(row.status) && !blockingObligation(row)).map(({ id, title, text, owner }) => ({ id, title: title ?? text ?? null, owner: owner ?? null }));
export function drainReasons(store, { obligations = 'blocking' } = {}) {
  const reasons = [];
  const active = store.live('flow').filter(f => blocksDrain(store, f));
  if (active.length) reasons.push(`drain or explicitly abandon all flows: ${active.slice(0, 10).map(f => `${f.id} (${f.kind}, ${f.state})`).join(', ')}${active.length > 10 ? ` and ${active.length - 10} more` : ''}`);
  if (!store.live('attempt').every(a => a.settledAt || ['passed', 'failed', 'not-dispatched', 'aborted'].includes(a.status))) reasons.push('reconcile all unresolved attempts');
  const open = store.live('obligation').filter(row => obligations === 'all' ? !['passed', 'failed', 'deferred'].includes(row.status) : blockingObligation(row));
  if (open.length) reasons.push(`resolve outstanding obligations that need authorization: ${open.slice(0, 5).map(row => row.id).join(', ')}`);
  return reasons;
}
// The stored configuration is validated by the release being adopted, not by the CLI that runs this
// command: its own `validateConfig` (factory/core/configuration.mjs in the release's files) is
// loaded in a separate Node process and given the configuration on standard input. The files are
// always a release directory that readRelease has just verified against the manifest digest the
// operator pinned, never files from the project's remote. A verified release whose validator
// cannot be loaded cannot be checked, and is refused.
const VALIDATOR = 'core/configuration.mjs';
const VALIDATE_SCRIPT = `import { pathToFileURL } from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
let validate; try { validate = (await import(pathToFileURL(process.argv[1]).href)).validateConfig; if (typeof validate !== 'function') throw new Error('it exports no validateConfig'); } catch (error) { console.log(JSON.stringify({ load: String(error?.message ?? error) })); process.exit(0); }
try { validate(JSON.parse(input)); console.log(JSON.stringify({ ok: true })); } catch (error) { console.log(JSON.stringify({ problem: String(error?.message ?? error) })); }`;
const CONFIG_CHECK_TIMEOUT_MS = 60_000;
// Why the release whose factory files are in `factoryDir` would refuse the project's stored
// configuration, with the fix; null when it would not.
export function storedConfigProblem(config, factoryDir, { version = null } = {}) {
  const release = `the release being adopted${version ? ` (${version})` : ''}`, validator = join(factoryDir ?? '', VALIDATOR);
  const unchecked = reason => `the project's stored configuration cannot be checked against ${release}: its validator (factory/${VALIDATOR}) ${reason}. Nothing was changed. The upgrade is refused rather than applied unchecked: it would otherwise land and its config update --current could then fail, leaving the project unable to recommission`;
  if (typeof factoryDir !== 'string' || !factoryDir || !existsSync(validator)) return unchecked('is not in the release');
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', VALIDATE_SCRIPT, validator], { input: JSON.stringify(config ?? {}), encoding: 'utf8', timeout: CONFIG_CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  let result = null; try { result = JSON.parse(String(ran.stdout ?? '').trim().split('\n').at(-1)); } catch { /* reported below */ }
  if (!result || ran.status !== 0) return unchecked(`did not run (${ran.error?.message ?? (String(ran.stderr ?? '').trim().split('\n').at(-1) || `exit ${ran.status}`)})`);
  if (result.load !== undefined) return unchecked(`could not be loaded (${result.load})`);
  if (result.ok === true) return null;
  const block = /\b(upkeep|learnings)\b/.exec(result.problem)?.[1];
  return `the project's stored configuration is not valid for ${release}, so the upgrade would leave it unable to recommission: ${result.problem}. Nothing was changed. Correct it first, with the release the project runs now (config show > factotum.json, edit, config update --config factotum.json), then run the upgrade again${block ? `. Earlier releases ignored the ${block} block; this one validates it: replace it with a valid block, for example "upkeep": {"mode": "off"}, or remove it` : ''}`;
}
const assertStoredConfig = (config, factoryDir, options) => { const problem = storedConfigProblem(config, factoryDir, options); assert(!problem, problem); };
// --activate takes no release directory of its own: the release is already on the remote target.
// The stored configuration is validated before activation only with a release directory that
// readRelease verifies against the pinned manifest digest: the one the operator passes
// (--release), or the release artifact this CLI runs from (<release>/starter/factory/cli.mjs, the
// documented way to run the command). Code at the remote target is never run for it. With no such
// directory the check is skipped and said to be: doctor, after activation, is then the check, as
// it was before this preflight existed. Returns what was done, for the command's result.
const OWN_RELEASE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function activationConfigCheck(config, releaseDir, expectedDigest) {
  const skipped = why => ({ release: null, checked: false, reason: `the stored configuration was not checked before activation: ${why}. Doctor, after activation, is the check. To have it checked first, pass --release <the release directory with this digest>, or run upgrade apply with the CLI of that release (<release>/starter/factory/cli.mjs)` });
  let release, source;
  // A directory the operator names must be that release: a wrong one is refused, not skipped.
  if (releaseDir !== undefined) { release = readRelease(releaseDir, expectedDigest); source = 'the release directory given'; }
  else {
    if (!existsSync(join(OWN_RELEASE, 'release.json'))) return skipped('no release directory was given, and this CLI does not run from a release artifact');
    try { release = readRelease(OWN_RELEASE, expectedDigest); source = 'the release this CLI runs from'; }
    catch (error) { return skipped(`no release directory was given, and the release this CLI runs from is not the one being activated (${error.message})`); }
  }
  assertStoredConfig(config, join(release.payload, 'factory'), { version: release.manifest.version });
  return { release, checked: true, version: release.manifest.version, source };
}
function readProject(stateDir, root) {
  const store = new Store(stateDir);
  try {
    const project = store.meta('project'), reasons = drainReasons(store);
    assert(realpathSync(resolve(root)) === project.root, 'the project root does not match this state directory');
    assert(!reasons.length, `upgrade requires a drained project: ${reasons.join('; ')}`);
    return { project, config: store.meta('config', {}), carriedOver: carriedObligations(store) };
  } finally { store.close(); }
}
// The project runner holds this abstract socket while it runs.
async function runnerLock(projectId) {
  const lock = createServer();
  await new Promise((done, reject) => { lock.once('error', () => reject(new Error('the project runner is still running; stop it (or its unit) first'))); lock.listen(`\0factotum-runner-${projectId}`, done); });
  return () => new Promise(done => lock.close(done));
}

// ---- Units and the checkout (dev.87) ----
// One rule decides whether units that upgrade apply stopped may run again: the checkout verifies, read
// from the files on disk (checkCheckout: the lock authenticated, the project's anchor, and every
// installed file hashed from its bytes, never from Git's index or stat cache), as doctor's drift check
// reads it. --merge and --activate check it before they stop anything, and again before they start
// any unit; so does the recovery of a run that did not finish. When it does not verify, the units
// stay stopped and the message says why and what to run. The checkout moves once, after the units are
// stopped; when the upgrade's own check of the new commit fails, it is returned to the commit it held
// before (git reset --keep) and checked again. The project's state keeps one record
// (`upgradeRecovery`) from the first unit stopped until every stopped unit is confirmed running: the
// units, and the commit the checkout held before, which is only a hint for the instructions.
const RECOVERY = 'upgradeRecovery';
// The CLI running this code: the one the operator ran (the release's own, or the project's).
const OWN_CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const short = commit => String(commit ?? 'an unknown commit').slice(0, 12);
// One line for a failed command: what it printed last, not the whole command line.
const failure = error => (String(error?.stderr ?? '').trim().split('\n').filter(Boolean).at(-1) ?? String(error?.message ?? error).split('\n')[0]);
const withStore = (stateDir, fn) => { const store = new Store(stateDir); try { return fn(store); } finally { store.close(); } };
const readRecovery = stateDir => withStore(stateDir, store => store.meta(RECOVERY, null));
const writeRecovery = (stateDir, record) => withStore(stateDir, store => store.setMeta(RECOVERY, record ? { ...record, at: new Date().toISOString() } : null));
const commandName = operation => `upgrade apply ${operation === 'merge' ? '--merge' : '--activate'}`;
// The checkout, from the files on disk. `paths`: installed files that differ from the lock or are missing.
// `restart`: the units may run on it again, which also needs an authenticated lock: its own evidence,
// the exact lock a verified release authenticated for this project (the anchor), or `release`. A root
// lock without evidence passes the check before anything is stopped (the transition), not this one.
function checkCheckout(root, stateDir, release = null, { restart = false } = {}) {
  try {
    const anchor = withStore(stateDir, readAnchor), status = adoptionStatus({ root, history: false, release, anchor });
    if (!status.clean) return { problem: `installed files differ from ${LOCK} (release ${status.version}): ${status.conflicts.slice(0, 5).map(c => `${c.path} (${c.reason})`).join('; ')}`, paths: status.conflicts.filter(c => c.reason !== 'unmanaged file inside upstream-owned factory').map(c => c.path), extra: status.conflicts.filter(c => c.reason === 'unmanaged file inside upstream-owned factory').map(c => c.path) };
    if (restart && !status.authenticated && anchor?.releaseVerified?.lockSha256 !== status.lockSha256) return { problem: `${LOCK} (release ${status.version}) carries no layout evidence (a root lock written before dev.87), so nothing shows that its files are that release's, and no unit is started on it. Authenticate it with that release's verified directory: --release <the directory of release ${status.version}> --digest ${status.release.manifestDigest} with upgrade apply --recover`, paths: [], needsRelease: { version: status.version, digest: status.release.manifestDigest } };
    return { problem: null, paths: [] };
  } catch (error) { return { problem: error.message, paths: [] }; }
}
const recoverCommand = ({ root, stateDir, release, needsRelease }) => `node ${shellWord(OWN_CLI)} upgrade apply --recover --actor operator --root ${shellWord(root)} --state ${shellWord(stateDir)}${needsRelease ? ` --release <the directory of release ${needsRelease.version}> --digest ${needsRelease.digest}` : release ? ` --release ${shellWord(release.root)} --digest ${release.manifestDigest}` : ''}`;
// Every command an operator is told to run, in order, after "To finish, run in order:"; tests run them
// exactly as written. Changed files are never stashed (a stash would put untracked files, secrets
// included, into Git objects): the operator copies what they want outside the repository first.
function returnText({ root, stateDir, hint, release, check }) {
  let head = null; try { head = git(root, ['rev-parse', 'HEAD']); } catch {}
  let changed = []; try { changed = git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean); } catch {}
  const restore = [...new Set([...changed, ...(check?.paths ?? [])])];
  const commands = [
    ...(restore.length ? [`git -C ${shellWord(root)} checkout -- ${restore.map(shellWord).join(' ')}`] : []),
    ...(hint && hint !== head ? [`git -C ${shellWord(root)} reset --keep ${hint}`] : []),
    recoverCommand({ root, stateDir, release, needsRelease: check?.needsRelease }),
  ];
  return `First look at \`git -C ${shellWord(root)} status --short\`, and copy anything you want to keep to a private backup outside the repository (do not stash it: a stash puts untracked files into Git objects).${check?.extra?.length ? ` Move these files out of the repository too, they are not part of the release: ${check.extra.join(', ')}.` : ''} To finish, run in order: ${commands.map(command => `\`${command}\``).join(', then ')}.${restore.length ? ` The checkout discards the changes to ${restore.join(', ')}.` : ''}${hint && hint !== head ? ` git reset --keep refuses rather than overwrite a changed file ("Entry '<path>' not uptodate" or "would be overwritten by merge"): back that file up outside the repository, restore it with git -C ${shellWord(root)} checkout -- <path> (or move an untracked one out of the repository), and run the reset again.` : ''} upgrade apply --recover checks the checkout from its files and starts the units only if it verifies.`;
}
// Start each unit that is not running, then confirm all of them run. Returns those that do not.
async function startConfirmed(units, run) {
  const errors = new Map();
  for (const name of units) { try { if (!(await unitActive(name, { run }))) await startUnit(name, { run }); } catch (error) { errors.set(name, failure(error)); } }
  const down = [];
  for (const name of units) { let up = false; try { up = await unitActive(name, { run }); } catch {} if (!up) down.push({ name, error: errors.get(name) ?? 'not running after its start' }); }
  return down;
}
const downText = ({ root, stateDir, release, down }) => `${down.map(row => `${row.name} (${row.error})`).join(', ')} did not start; the record stays in the project's state until every unit runs. To finish, run in order: ${[...down.map(row => `systemctl --user start ${shellWord(row.name)}`), recoverCommand({ root, stateDir, release })].map(command => `\`${command}\``).join(', then ')}.`;
// The units an upgrade stops, recorded one by one before each is stopped.
async function stopUnits({ stateDir, operation, hint, units, stopped, run }) {
  for (const name of units) if (await unitActive(name, { run })) { stopped.push(name); writeRecovery(stateDir, { operation, hint, units: stopped }); await stopUnit(name, { run }); }
  return { units: [...stopped] };
}
// At the end of --merge or --activate. A checkout the upgrade did not verify is returned to the
// commit it held before; then the units start only if the checkout verifies from its files.
async function finishUnits({ root, stateDir, release, before, verified, stopped, step, restarts, run }) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const hold = why => step.record({ step: 'hold', ok: false, durationMs: 0, units: [...stopped], error: `the units ${stopped.length ? stopped.join(', ') : '(none were running)'} were left stopped: ${why}. Do not start them on this checkout. ${returnText({ root, stateDir, hint: before, release, check: checkCheckout(root, stateDir, release, { restart: true }) })}` });
  if (!verified && head !== before) {
    try { git(root, ['reset', '--keep', before]); step.record({ step: 'rollback', ok: true, durationMs: 0, from: head, to: before }); }
    catch (error) { hold(`the upgrade did not verify ${short(head)}, and returning the checkout to ${short(before)}, the commit it held before, failed (${failure(error)})`); return; }
  }
  const check = checkCheckout(root, stateDir, release, { restart: true });
  if (check.problem) { hold(`the checkout does not verify: ${check.problem}`); return; }
  await restarts.rest();
  const down = await startConfirmed(stopped, run);
  if (down.length) { writeRecovery(stateDir, { ...readRecovery(stateDir), units: down.map(row => row.name) }); step.record({ step: 'units', ok: false, durationMs: 0, error: downText({ root, stateDir, release, down }) }); return; }
  writeRecovery(stateDir, null);
}
// Finish a --merge or --activate that did not finish. If the checkout verifies from its files with an
// authenticated lock, it ends the way a run ends: recommission and doctor with the checkout's own CLI,
// then the units it stopped, only if both succeeded. The recorded commit only shapes the instructions;
// nothing in the record is trusted.
async function recoverInterrupted({ stateDir, root, run, runCli, release = null, actor = 'operator', onBehalfOf }) {
  const record = readRecovery(stateDir);
  if (!record) return null;
  const project = withStore(stateDir, store => store.meta('project'));
  assert(realpathSync(resolve(root)) === project?.root, 'the project root does not match this state directory');
  const checkout = project.root, units = Array.isArray(record.units) ? record.units.filter(name => typeof name === 'string') : [];
  const what = `an earlier ${commandName(record.operation)} (recorded ${record.at ?? 'at an unknown time'}) did not finish and left ${units.length ? `the units ${units.join(', ')} stopped` : 'no unit stopped'}`;
  const check = checkCheckout(checkout, stateDir, release, { restart: true });
  if (check.problem) throw new Error(`${what}. They stay stopped, and nothing else was done: the checkout does not verify: ${check.problem}. ${returnText({ root: checkout, stateDir, hint: typeof record.hint === 'string' ? record.hint : null, release, check })}`);
  const config = withStore(stateDir, store => store.meta('config', {})), secrets = upgradeSecrets(config), steps = [], step = stepRecorder(steps, secrets);
  await recommissionAndDoctor({ step, cli: cliRunner(checkout, run, runCli), cliPath: factoryCli(checkout), stateDir, secrets, actor, onBehalfOf, note: `Recommission when recovering an unfinished ${commandName(record.operation)}` }).catch(() => { /* recorded on the failing step */ });
  const failed = steps.find(row => !row.ok);
  if (failed) throw new Error(`${what}. The checkout verifies, but its ${failed.step} step failed, so they stay stopped: ${failed.error}. Fix what it names, then run \`${recoverCommand({ root: checkout, stateDir, release })}\`, which recommissions, runs doctor and starts them`);
  const down = await startConfirmed(units, run);
  if (down.length) { writeRecovery(stateDir, { ...record, units: down.map(row => row.name) }); throw new Error(`${what}. The checkout verifies and was recommissioned, and doctor passed, but ${downText({ root: checkout, stateDir, release, down })}`); }
  writeRecovery(stateDir, null);
  return { step: 'recover', ok: true, durationMs: 0, operation: record.operation, checkout: git(checkout, ['rev-parse', 'HEAD']), units, recommissioned: true };
}
// upgrade apply --recover: only the recovery, for a run that stopped partway. With --release and
// --digest, the verified release can authenticate a lock without evidence of its own.
export async function recoverUpgrade({ root, stateDir, releaseDir, expectedDigest, run = runProcess, runCli, actor = 'operator', onBehalfOf }) {
  const release = releaseDir !== undefined ? readRelease(releaseDir, expectedDigest) : null;
  const recovered = await recoverInterrupted({ stateDir, root, run, runCli, release, actor, onBehalfOf });
  return recovered ? { recovered: true, ...recovered } : { recovered: false, note: 'no unfinished upgrade apply is recorded for this project' };
}
// Errors after a recovery say it happened: the operator otherwise sees only the new refusal.
async function afterRecovery(recovered, fn) {
  try { return await fn(); }
  catch (error) { if (recovered) error.message = `${error.message} (before this, an unfinished ${commandName(recovered.operation)} was recovered: the checkout ${short(recovered.checkout)} verified and ${recovered.units.length ? `the units ${recovered.units.join(', ')} run` : 'no unit needed starting'})`; throw error; }
}
// Before anything is stopped: units are stopped only on a checkout that would let them start again.
function assertCheckoutVerifies(root, stateDir) {
  const { problem } = checkCheckout(root, stateDir);
  assert(!problem, `the project checkout does not verify, so nothing was stopped or changed: ${problem}. adopt status --root ${shellWord(root)} --state ${shellWord(stateDir)} and doctor say what is wrong; fix it first, then run the upgrade again`);
}

// With the verified release, the lock's managed files are checked against its manifest too: this
// authenticates a root lock written before dev.87, which carries no layout evidence. The project's
// record of its lock's authentication (core/adoption-anchor.mjs) is consulted and updated.
function liveAdoption(root, expectedDigest, release, stateDir) {
  const status = adoptionStatus({ root, release, anchor: withStore(stateDir, readAnchor) });
  assert(status.release?.manifestDigest === expectedDigest, `the project checkout does not hold the release with manifest ${expectedDigest.slice(0, 12)}… after the merge`);
  assert(status.clean, `the installed files differ from ${status.version}'s lock after the merge: ${status.conflicts.slice(0, 5).map(c => `${c.path} (${c.reason})`).join('; ')}. If only line endings differ, turn off the conversion (such as core.autocrlf) for these paths; otherwise find what changed them (the sync with the remote target brings in its commits), then run --merge again`);
  withStore(stateDir, store => recordAuthentication(store, status));
  return { version: status.version, clean: true };
}
export function prepareUpgrade({ root, stateDir, releaseDir, expectedDigest, branch, worktreeDir }) {
  { const record = readRecovery(stateDir); if (record) throw new Error(`an earlier ${commandName(record.operation)} did not finish (recorded ${record.at ?? 'at an unknown time'}) and may have left units stopped. Finish it first: \`${recoverCommand({ root: realpathSync(resolve(root)), stateDir })}\` (or run upgrade apply --merge or --activate again, which do the same first)`); }
  const { config, carriedOver } = readProject(stateDir, root);
  // Before anything is prepared: the release's own validator must accept what the project stores.
  { const release = readRelease(releaseDir, expectedDigest); assertStoredConfig(config, join(release.payload, 'factory'), { version: release.manifest.version }); }
  const prepared = prepareAdoption({ root, releaseDir, expectedDigest, branch, worktreeDir });
  return { ...prepared, carriedOverObligations: carriedOver, next: `Review the worktree, commit the update there, then rerun upgrade apply with --merge and --out <new backup directory>.` };
}

export async function mergeUpgrade(options) {
  const recovered = await recoverInterrupted({ stateDir: options.stateDir, root: options.root, run: options.run ?? runProcess, runCli: options.runCli, actor: options.actor ?? 'operator', onBehalfOf: options.onBehalfOf });
  return afterRecovery(recovered, () => merge(options, recovered));
}
async function merge({ root, stateDir, releaseDir, expectedDigest, branch, worktreeDir, backupDir, push = false, run = runProcess, runCli, actor = 'operator', onBehalfOf }, recovered) {
  const { project, config, carriedOver } = readProject(stateDir, root), worktree = resolve(worktreeDir), steps = [];
  assertNoHistoryRewrites(project.root);
  assert(typeof backupDir === 'string' && backupDir, '--out <new backup directory> is required');
  // The reviewed change: committed, clean, pinned to this exact release, and a fast-forward of the checkout.
  const release = readRelease(releaseDir, expectedDigest);
  // Before anything is stopped or merged: the release's own validator must accept what the project stores.
  assertStoredConfig(config, join(release.payload, 'factory'), { version: release.manifest.version });
  const reviewWorktree = what => {
    const status = adoptionStatus({ root: worktree, release });
    assert(status.clean && status.release.manifestDigest === expectedDigest && status.version === release.manifest.version, `the review worktree does not hold a clean adoption of this release${what}${status.conflicts.length ? `: ${status.conflicts.slice(0, 5).map(c => `${c.path} (${c.reason})`).join('; ')}` : ''}`);
    return status;
  };
  const status = reviewWorktree('');
  const targetCompatibility = readCompatibility(readFileSync(join(release.payload, 'compatibility.json'), 'utf8'));
  assert(!git(worktree, ['status', '--porcelain', '--untracked-files=all']), 'commit the reviewed update in the worktree first');
  assert(!git(project.root, ['status', '--porcelain', '--untracked-files=all']), 'the project checkout has uncommitted changes');
  // The reviewed commit, before the sync below can rebase the branch (which drops commits the target already has).
  const reviewed = git(worktree, ['rev-parse', 'HEAD']), live = git(project.root, ['rev-parse', 'HEAD']);
  // What was reviewed: the branch's changes against the commit it was prepared on, blob by blob.
  const changes = (from, to) => git(project.root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', from, to]);
  const reviewedChanges = changes(live, reviewed);
  // Catch up with the remote target first: work merged on the forge while waiting (for example
  // the flow the upgrade waited for) must not be pushed over. Only the review branch moves: it is
  // rebased onto the target in the review worktree, outside the live checkout, and must then carry
  // exactly the reviewed changes and verify there, before anything is stopped; otherwise it is put
  // back on the reviewed commit. The live checkout moves once, later, to the verified branch.
  const remote = config.repository?.remote ?? 'origin', target = config.repository?.target;
  const sync = (() => {
    if (!target) return null;
    try { git(project.root, ['fetch', '--no-tags', remote, `refs/heads/${target}`]); } catch { return { skipped: 'fetch failed' }; }
    const remoteHead = git(project.root, ['rev-parse', 'FETCH_HEAD']);
    if (remoteHead === live) return null;
    try { git(project.root, ['merge-base', '--is-ancestor', remoteHead, live]); return null; } catch {}
    try { git(project.root, ['merge-base', '--is-ancestor', live, remoteHead]); } catch { throw new Error(`the project checkout and ${remote}/${target} have diverged; reconcile them before upgrading`); }
    // Attributes and submodules change how Git checks files out (filters, line endings), which the
    // reviewed changes would not show: a target that changed any is reviewed again, before the rebase.
    const steering = git(project.root, ['diff', '--name-only', '--no-renames', '-z', live, remoteHead]).split('\0').filter(path => /(^|\/)\.git(attributes|modules)$/.test(path));
    assert(!steering.length, `${remote}/${target} (${short(remoteHead)}) changed ${steering.join(', ')} since the review branch was prepared: they change how Git checks files out (filters, line endings, submodules), which the reviewed changes do not show. Nothing was stopped and the project checkout and review branch did not move. Prepare the upgrade again (upgrade apply without --merge, on a new branch) so it is reviewed on top of ${remote}/${target}`);
    try { git(worktree, ['rebase', remoteHead]); } catch { try { git(worktree, ['rebase', '--abort']); } catch {} throw new Error(`the review branch does not rebase cleanly onto ${remote}/${target} (${remoteHead.slice(0, 12)}); update it and try again`); }
    return { from: live, to: remoteHead, rebased: true };
  })();
  const head = sync?.to ?? live, tip = git(project.root, ['rev-parse', `refs/heads/${branch}`]);
  try {
    // A reviewed upgrade the checkout (or the remote target) already contains was merged before: by
    // this command, or inside another change that merged the branch. When it then does not hold this
    // release, the upgrade was merged and undone (for example by a candidate that merged the branch and
    // restored the old lock and core); merging the branch again would change nothing, so say that plainly.
    const contains = commit => { try { git(project.root, ['merge-base', '--is-ancestor', reviewed, commit]); return true; } catch { return false; } };
    if (contains(live)) {
      const status = (() => { try { return adoptionStatus({ root: project.root }); } catch (error) { return { error: error.message }; } })();
      if (status.release?.manifestDigest === expectedDigest) {
        assert(!status.clean, `the review branch ${branch} is already merged into the project checkout, which holds ${release.manifest.version}: there is nothing to merge. Remove the review branch and worktree (adopt cleanup), then run config update --current and doctor if that was not done`);
        // The lock is this release's, but installed files differ from it: a merge whose verify step failed (before dev.87).
        throw new Error(`the review branch ${branch} is already merged into the project checkout, which holds ${release.manifest.version}, but its installed files differ from the lock (verify failed): ${status.conflicts.slice(0, 5).map(c => `${c.path} (${c.reason})`).join('; ')}. Rerunning --merge is not possible: restore the files from the merged commit (git checkout -- <paths>), or, if only line endings differ, turn off the conversion (such as core.autocrlf) and check them out again; then run adopt cleanup, config update --current and doctor`);
      }
      throw new Error(`the review branch ${branch} (${reviewed.slice(0, 12)}) is already contained in the project checkout${sync ? ` and the remote target` : ''}, but the checkout does not hold release ${release.manifest.version} (${status.error ? `its adoption cannot be read: ${status.error}` : `its lock names ${status.version ?? 'no release'}`}): the upgrade was merged and then undone, for example by a change that merged this branch and restored the old lock and core. Merging the branch again changes nothing. Find and revert the change that undid it, or prepare the upgrade again on a new branch (upgrade apply without --merge) and merge that`);
    }
    if (contains(head)) {
      // Merged on the remote target (a pull request), not yet in the checkout: that is --activate's work.
      const lock = (() => { try { return JSON.parse(git(project.root, ['show', `${head}:${LOCK}`])); } catch { return null; } })();
      throw new Error(lock?.release?.manifestDigest === expectedDigest ? `the review branch ${branch} is already merged into ${remote}/${target}, which holds ${release.manifest.version}: there is nothing to merge. Activate it with upgrade apply --activate (with --release), then remove the review branch and worktree (adopt cleanup)` : `the review branch ${branch} (${reviewed.slice(0, 12)}) is already contained in ${remote}/${target}, but its lock there does not name release ${release.manifest.version}: the upgrade was merged and then undone. Find and revert the change that undid it, or prepare the upgrade again on a new branch and merge that`);
    }
    assert(live !== tip, 'the review branch has no commits beyond the checkout');
    try { git(project.root, ['merge-base', '--is-ancestor', live, tip]); } catch { throw new Error('the review branch is not a fast-forward of the project checkout'); }
    assert(git(worktree, ['rev-parse', 'HEAD']) === tip, 'the review worktree is not at the branch tip');
    // The rebased branch, as the live checkout will hold it: the target's commits must keep every
    // installed file as this release's lock has it. A change there without its lock entry stops here.
    if (sync?.rebased) {
      // A rebase that skipped or altered a reviewed commit, or met a target commit touching a path the
      // review changed, would land something nobody reviewed: stop for a new review instead.
      assert(changes(sync.to, tip) === reviewedChanges, `the review branch's changes are not the reviewed ones after its rebase onto ${remote}/${target} (${short(sync.to)}): a commit there touched a path the review changed, or a reviewed commit was skipped as already applied. Nothing was stopped and the project checkout did not move; the review branch is back on the reviewed commit. Prepare the upgrade again (upgrade apply without --merge, on a new branch) so it is reviewed on top of ${remote}/${target}`);
      reviewWorktree(` after its rebase onto ${remote}/${target} (${short(sync.to)}): a commit there changed the installed files. Nothing was stopped and the project checkout did not move; the review branch is back on the reviewed commit. Fix the target, then prepare the upgrade again (upgrade apply without --merge, on a new branch)`);
    }
  } catch (error) { if (sync?.rebased) { try { git(worktree, ['reset', '-q', '--keep', reviewed]); } catch {} } throw error; }
  // The console unit is stopped only when it runs from this checkout; a shared console run from
  // another project's checkout is left alone.
  const units = [unitName('project', project.projectId), ...(await unitRunsFrom(unitName('console'), project.root, { run }) ? [unitName('console')] : [])], stopped = [];
  const cli = cliRunner(project.root, run, runCli);
  const secrets = upgradeSecrets(config), step = stepRecorder(steps, secrets);
  const restarts = unitRestarts({ step, run, stopped, consoleUnit: unitName('console') });
  if (recovered) step.record(recovered);
  if (sync) step.record({ step: 'sync-target', ok: true, durationMs: 0, ...sync });
  // Check the drain before stopping anything, so new work is found without interrupting it.
  { const store = new Store(stateDir); try { const reasons = drainReasons(store); assert(!reasons.length, `work started before the upgrade could stop the services: ${reasons.join('; ')}`); } finally { store.close(); } }
  assertCheckoutVerifies(project.root, stateDir);
  let verified = false;
  try {
    // Each unit is recorded before it is stopped, so a run that does not finish can be recovered.
    await step('stop', () => stopUnits({ stateDir, operation: 'merge', hint: live, units, stopped, run }));
    const unlock = await runnerLock(project.projectId);
    try {
      if (needsInlineLayout(stateDir, targetCompatibility)) await step('layout', () => inlineLayoutForRelease(stateDir, targetCompatibility));
      await step('backup', () => { const store = new Store(stateDir); try { assert(!drainReasons(store).length, 'work started while preparing the upgrade'); } finally { store.close(); } return backupProject(stateDir, backupDir); });
      await step('merge', () => { git(project.root, ['merge', '--ff-only', branch]); return { head: tip }; });
      // The live checkout now holds exactly this release, with every installed file as locked (as
      // activateUpgrade checks after its pull): drift here (a checkout conversion, say) stops the
      // upgrade before recommissioning, and the checkout is returned to the commit it held before.
      await step('verify', () => { const result = liveAdoption(project.root, expectedDigest, release, stateDir); verified = true; return result; });
      if (push) await step('push', () => {
        assert(target, 'push needs repository.target in the project configuration');
        git(project.root, ['push', remote, `HEAD:refs/heads/${target}`]); return { remote, target };
      });
      await step('cleanup', () => cleanupAdoption({ root: project.root, branch, worktreeDir: worktree }));
    } finally { await unlock(); }
    // Recommission and qualify with the newly merged code.
    await recommissionAndDoctor({ step, cli, cliPath: factoryCli(project.root), stateDir, secrets, actor, onBehalfOf, note: `Recommission after adopting ${status.version}`, afterRecommission: () => checkCheckout(project.root, stateDir, release, { restart: true }).problem ? null : restarts.afterRecommission() });
  } catch { /* recorded on the failing step */ }
  finally {
    // Units come back whatever happened later (admission stays gated on commissioning), but only on a
    // verified checkout or one returned to the last verified commit; otherwise they stay stopped.
    await finishUnits({ root: project.root, stateDir, release, before: live, verified, stopped, step, restarts, run });
  }
  return redactSecretValues({ version: status.version, carriedOverObligations: carriedOver, ok: steps.every(row => row.ok) && steps.some(row => row.step === 'doctor'), steps, doctorWarnings: steps.find(row => row.step === 'doctor')?.warnings ?? [] }, secrets);
}

// Activate a release whose reviewed adoption already landed on the remote target through a pull
// request (for example a protected target that only accepts squash merges). Nothing is merged or
// pushed: the drained project's checkout fast-forwards to the remote target, which must hold the
// exact release, then the project is recommissioned and qualified with the new code.
export async function activateUpgrade(options) {
  const recovered = await recoverInterrupted({ stateDir: options.stateDir, root: options.root, run: options.run ?? runProcess, runCli: options.runCli, actor: options.actor ?? 'operator', onBehalfOf: options.onBehalfOf });
  return afterRecovery(recovered, () => activate(options, recovered));
}
async function activate({ root, stateDir, expectedDigest, backupDir, releaseDir, run = runProcess, runCli, actor = 'operator', onBehalfOf }, recovered) {
  const { project, config, carriedOver } = readProject(stateDir, root), steps = [];
  assertNoHistoryRewrites(project.root);
  assert(typeof backupDir === 'string' && backupDir, '--out <new backup directory> is required');
  assert(/^[a-f0-9]{64}$/.test(expectedDigest ?? ''), '--digest <the release manifest digest> is required');
  assert(!git(project.root, ['status', '--porcelain', '--untracked-files=all']), 'the project checkout has uncommitted changes');
  const remote = config.repository?.remote ?? 'origin', target = config.repository?.target;
  assert(target, 'activation needs repository.target in the project configuration');
  assert(git(project.root, ['rev-parse', '--abbrev-ref', 'HEAD']) === target, `the project checkout must be on ${target}`);
  git(project.root, ['fetch', '--no-tags', remote, `refs/heads/${target}`]);
  const remoteHead = git(project.root, ['rev-parse', 'FETCH_HEAD']);
  try { git(project.root, ['merge-base', '--is-ancestor', 'HEAD', remoteHead]); } catch { throw new Error(`the project checkout has commits that are not on ${remote}/${target}`); }
  // Before anything is stopped or pulled: where a verified release directory is at hand, its own
  // validator must accept what the project stores. Nothing is ever read or run from the remote target
  // for this: its files are not bound to the pinned digest until they are pulled and checked.
  const { release, ...configCheck } = activationConfigCheck(config, releaseDir, expectedDigest);
  // Also before anything is stopped: the lock at the target, read as data, must authenticate its
  // managed files against the pinned digest (by its layout evidence, or against the verified release
  // for a root lock written before dev.87). A lock edited to match a replaced file is refused here.
  { let landed = null; try { landed = git(project.root, ['show', `${remoteHead}:${LOCK}`]); } catch { /* no lock there: the pull step refuses it */ }
    if (landed !== null) authenticateLandedLock(landed, { expectedDigest, release }); }
  { const store = new Store(stateDir); try { const reasons = drainReasons(store); assert(!reasons.length, `activation requires a drained project: ${reasons.join('; ')}`); } finally { store.close(); } }
  // The checkout's files against the pinned release: its digest, authenticated, every file as locked.
  const landedStatus = () => {
    const status = adoptionStatus({ root: project.root, release, anchor: withStore(stateDir, readAnchor) });
    assert(status.release?.manifestDigest === expectedDigest, `${remote}/${target} does not hold the release with manifest ${expectedDigest.slice(0, 12)}…; merge its reviewed adoption first`);
    assert(status.authenticated, `${LOCK} at ${remote}/${target} is a root lock without layout evidence and no verified release directory is at hand; pass --release <the release directory with this digest>, or prepare the adoption again with that release's own CLI, which writes the evidence`);
    assert(status.clean, `the installed files differ from ${status.release.version}'s lock: ${status.conflicts.slice(0, 5).map(c => `${c.path} (${c.reason})`).join('; ')}`);
    return status;
  };
  const before = git(project.root, ['rev-parse', 'HEAD']), pulled = before !== remoteHead;
  // Units are stopped only on a checkout that would let them start again (also when it already holds the target).
  assertCheckoutVerifies(project.root, stateDir);
  const units = [unitName('project', project.projectId), ...(await unitRunsFrom(unitName('console'), project.root, { run }) ? [unitName('console')] : [])], stopped = [];
  const cli = cliRunner(project.root, run, runCli);
  const secrets = upgradeSecrets(config), step = stepRecorder(steps, secrets);
  const restarts = unitRestarts({ step, run, stopped, consoleUnit: unitName('console') });
  if (recovered) step.record(recovered);
  let verified = false;
  try {
    // Each unit is recorded before it is stopped, so a run that does not finish can be recovered.
    await step('stop', () => stopUnits({ stateDir, operation: 'activate', hint: before, units, stopped, run }));
    const unlock = await runnerLock(project.projectId);
    try {
      // The release being activated is the one at the remote target: read its declaration from that commit.
      const targetCompatibility = (() => { try { return readCompatibility(git(project.root, ['show', `${remoteHead}:./compatibility.json`])); } catch { return null; } })();
      if (needsInlineLayout(stateDir, targetCompatibility)) await step('layout', () => inlineLayoutForRelease(stateDir, targetCompatibility));
      await step('backup', () => { const store = new Store(stateDir); try { assert(!drainReasons(store).length, 'work started while preparing the activation'); } finally { store.close(); } return backupProject(stateDir, backupDir); });
      // A refused pull leaves the checkout to finishUnits, which returns it to the commit it held
      // before and checks it before any unit starts.
      await step('pull', () => {
        if (pulled) git(project.root, ['merge', '--ff-only', remoteHead]);
        const status = landedStatus();
        verified = true; withStore(stateDir, store => recordAuthentication(store, status));
        return { head: remoteHead, version: status.version };
      });
    } finally { await unlock(); }
    await recommissionAndDoctor({ step, cli, cliPath: factoryCli(project.root), stateDir, secrets, actor, onBehalfOf, note: 'Recommission after activating a reviewed release', afterRecommission: () => checkCheckout(project.root, stateDir, release, { restart: true }).problem ? null : restarts.afterRecommission() });
  } catch { /* recorded on the failing step */ }
  finally { await finishUnits({ root: project.root, stateDir, release, before, verified, stopped, step, restarts, run }); }
  return redactSecretValues({ carriedOverObligations: carriedOver, configCheck, ok: steps.every(row => row.ok) && steps.some(row => row.step === 'doctor'), steps, doctorWarnings: steps.find(row => row.step === 'doctor')?.warnings ?? [] }, secrets);
}
