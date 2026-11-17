#!/usr/bin/env node
import { configWithModelDefaults } from './operations/model-settings.mjs';
import { commandHelp, cliHelp, COMMANDS, MAINTENANCE_OPERATIONS } from './core/command-help.mjs';
import { parseArgs } from 'node:util';
import { buildRelease, adoptionStatus, adoptionPlan, prepareAdoption, cleanupAdoption } from './distribution.mjs';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { readAnchor } from './core/adoption-anchor.mjs';
import { resolve, join } from 'node:path';
import { Store, initProject } from './core/store.mjs';
import { executeCommand, snapshot, blocksDrain } from './core/project.mjs';
import { referenceWorkflow, catalogDrift } from './core/catalog.mjs';
import { consoleUnit, installUnit, projectUnit, uninstallUnit, unitName } from './operations/services.mjs';
import { prepareUpgrade, mergeUpgrade, activateUpgrade, recoverUpgrade, drainReasons } from './operations/upgrade-apply.mjs';
import { cleanupPlan, cleanupApply, restoreFlowArchive } from './operations/workspace-cleanup.mjs';
import { archiveDropPlan, archiveDropApply } from './operations/cleanup-archive-drop.mjs';
import { validateConfig } from './core/configuration.mjs';
import { cliCommand } from './core/install-layout.mjs';
import { uid, assert, digest, fileDigest } from './core/contracts.mjs';
import { backupProject, restoreProject } from './core/backup.mjs';
import { previewAuthorityMigration, applyAuthorityMigration } from './operations/authority-migration.mjs';
import { inlineLayout, layoutStatus, migrateLayout } from './operations/state-layout.mjs';
import { authorityStatus } from './core/decision-authority.mjs';
import { startProjectService, publicValue } from './service/project-service.mjs';
import { dashboardSnapshot } from './service/dashboard.mjs';
import { stateView } from './operations/state-view.mjs';
import { startConsole, registerProject, unregisterProject } from './console/console.mjs';

import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { reconcileAttempt } from './workflows/reconcile.mjs';
import { doctor, doctorProgressLine, importGitHubTask } from './workflows/commission.mjs';
import { retentionPlan, applyRetention, stageUpgrade, finishUpgrade, resolveInstallation } from './operations/index.mjs';

const OPTIONS = {
  help:{type:'boolean',short:'h',default:false}, attempt: { type: 'string' }, replace: { type: 'boolean', default: false }, instruction: { type: 'string' }, reference: { type: 'string' }, authority: { type: 'string' }, merge: { type: 'boolean', default: false }, push: { type: 'boolean', default: false }, current: { type: 'boolean', default: false }, 'replace-live': { type: 'boolean', default: false }, 'unreleased-schema': { type: 'boolean', default: false }, 'when-drained': { type: 'boolean', default: false }, activate: { type: 'boolean', default: false }, recover: { type: 'boolean', default: false }, 'max-wait-hours': { type: 'string' }, start: { type: 'boolean', default: true },
  development: { type: 'boolean', default:false }, release: { type: 'string' }, prefix: { type: 'string' }, branch: { type: 'string' }, worktree: { type: 'string' },
  config: { type: 'string' }, note: { type: 'string' }, issue: { type: 'string' }, preservation: { type: 'string' }, digest: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' }, install: { type: 'string' }, compatibility: { type: 'string' }, verify: { type: 'string' },
  state: { type: 'string' }, root: { type: 'string' }, name: { type: 'string' }, workflow: { type: 'string' },
  supervisor: { type: 'string', default: 'systemd' }, socket: { type: 'string' }, port: { type: 'string', default: '0' },
  operation: { type: 'string' }, payload: { type: 'string' }, file: { type: 'string' }, id: { type: 'string' },
  actor: { type: 'string' }, out: { type: 'string' }, from: { type: 'string' }, project: { type: 'string' },
  inbox: { type: 'string' }, flow: { type: 'string' }, task: { type: 'string' }, compact: { type: 'boolean', default: false },
  completed: { type: 'boolean', default: false },
};
// A missing, ambiguous or unexpected option value is a usage error: say which option and print the
// subcommand's usage (exit 2), never a stack trace.
function parseCommandLine(args) {
  try { return parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS }); }
  catch (error) {
    if (!String(error?.code ?? '').startsWith('ERR_PARSE_ARGS_')) throw error;
    const option = /'(-[^' ]+)/.exec(error.message)?.[1] ?? null;
    const reason = !option ? error.message
      : error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `unknown option ${option}`
      : /does not take an argument/.test(error.message) ? `${option} takes no value`
      : `${option} needs a value${/ambiguous/.test(error.message) ? ` (the next argument starts with "-"; write ${option}=<value> if that is the value)` : ''}`;
    usageError(reason, parseArgs({ args, allowPositionals: true, strict: false, options: OPTIONS }).positionals);
  }
}
function usageError(reason, words = positionals) {
  const help = words?.[0] ? cliHelp(words[0], words[1]) : null;
  const name = words?.[1] && help?.text.startsWith(`Usage: ${words[0]} ${words[1]}`) ? `${words[0]} ${words[1]}` : words?.[0];
  const usage = help && !help.unknown ? `\n${help.text.split('\n\n')[0]}\nRun ${name} --help for the options.` : '';
  console.error(`factotum${words?.[0] ? ` ${words[0]}` : ''}: ${reason}${usage}`);
  process.exit(2);
}
const { positionals, values } = parseCommandLine(process.argv.slice(2));
// Numeric option values are checked before anything runs.
function numberOption(key, { integer = true, min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (values[key] === undefined) return fallback;
  const n = Number(values[key]);
  if (values[key].trim() === '' || !Number.isFinite(n) || (integer && !Number.isSafeInteger(n)) || n < min || n > max) usageError(`--${key} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}, not ${JSON.stringify(values[key])}`);
  return n;
}
const NUMBERS = { port: { max: 65535 }, issue: { min: 1 }, 'max-wait-hours': { integer: false, max: 8760, fallback: 72 } };
for (const [key, bounds] of Object.entries(NUMBERS)) numberOption(key, bounds);
const print = value => console.log(JSON.stringify(value, null, 2));
// Every command says who is acting; there is no default identity.
const actor = () => { assert(['operator', 'orchestrator'].includes(values.actor), '--actor operator|orchestrator is required: say who is acting (add --instruction when acting on an operator instruction)'); return values.actor; };
const required = key => { if (!values[key]) throw new Error(`--${key} is required`); return values[key]; };
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
// adopt status --state: the project's record of its lock's authentication (core/adoption-anchor.mjs).
// Without a readable state the lock gets the transition behaviour, and the warning says what was not checked.
function adoptionAnchorFor(root, stateDir) {
  if (stateDir === undefined) return { note: "pass --state <the project's state directory> to check it against the project's record of its authentication" };
  let store; try { store = new Store(stateDir); } catch (error) { return { note: `the project state ${stateDir} could not be read (${error.message}), so the lock was not checked against the project's record of its authentication` }; }
  try { assert(store.meta('project')?.root === realpathSync(resolve(root)), 'the project root does not match this state directory'); return { anchor: readAnchor(store) }; } finally { store.close(); }
}
async function main() {
  // command --help lists the commands; command --operation X --help describes one.
  if (values.help && positionals[0] === 'command') { if (values.operation) { const help = commandHelp(values.operation); console.log(help.text); if (help.unknown) process.exitCode = 1; } else console.log(`${cliHelp('command').text}\n\nOperations (add --operation <name> --help for the payload):\n${Object.entries(COMMANDS).sort().map(([k, [summary]]) => `  ${k.padEnd(20)} ${summary}`).join('\n')}\n\nMaintenance operations run through maintenance enqueue: ${MAINTENANCE_OPERATIONS.join(', ')}`); process.exit(); }
  // Every other subcommand: <subcommand> [action] --help prints its usage and options and runs nothing.
  if (values.help && positionals[0]) { const help = cliHelp(positionals[0], positionals[1]); console.log(help.text); if (help.unknown) process.exitCode = 1; return; }
  switch (values.help?'help':positionals[0]) {
    case 'release': {
      assert(positionals[1]==='build','use release build');print(buildRelease({sourceDir:required('source'),outputDir:required('out'),version:required('version'),allowWorkingTree:values.development}));break;
    }
    case 'adopt': {
      const root=required('root');
      if(positionals[1]==='status'){const anchor=adoptionAnchorFor(root,values.state);const result=adoptionStatus({root,anchor:anchor.anchor});print(result);if(result.warning)process.stderr.write(`warning: ${result.warning}${anchor.note?` (${anchor.note})`:''}\n`);if(!result.clean)process.exitCode=1;}
      else if(positionals[1]==='cleanup')print(cleanupAdoption({root,branch:required('branch'),worktreeDir:required('worktree')}));
      else {
        assert(['plan','install','update'].includes(positionals[1]),'use adopt status, plan, install, update or cleanup');
        const initial=positionals[1]==='install';const options={root,releaseDir:required('release'),expectedDigest:required('digest'),initial,...(values.prefix!==undefined?{prefix:values.prefix}:{})};
        if(positionals[1]==='plan'){const result=adoptionPlan(options);print(result);if(!result.ok)process.exitCode=1;}
        else print(prepareAdoption({...options,branch:required('branch'),worktreeDir:required('worktree')}));
      }
      break;
    }
    case 'init': print(initProject({ stateDir: required('state'), root: required('root'), name: required('name'), workflow: values.workflow ? readJSON(values.workflow) : undefined, config: values.config ? readJSON(values.config) : {}, supervisor: values.supervisor })); break;
    case 'doctor': {
      // While commissioning is not current, admission is already held, so doctor can qualify
      // without stopping the runner. Re-qualifying a commissioned project still needs it stopped.
      const store = new Store(required('state')); let held;
      try { const c = store.meta('commissioning'); held = !(c?.ready && c.configDigest === store.meta('configDigest')); } finally { store.close(); }
      // Progress goes to stderr as "doctor: [<phase>] <detail>": what doctor is doing or waiting on
      // (permit wait, a provider probe, the forge check, main verification). upgrade apply reads the
      // last one to say where a doctor it ran stopped.
      const run = async () => { const result = await doctor(required('state'), { onProgress: (phase, detail) => console.error(doctorProgressLine(phase, detail)) }); print(result); if (!result.ready) process.exitCode = 1; };
      if (held) await run(); else await exclusiveMaintenance(run);
      break;
    }
    case 'reconcile': print(await reconcileAttempt(required('state'), required('attempt'), { reason: required('note') })); break;
    // Recorded as task.put by --actor, with the same authority rules as any other command.
    case 'import-task': print(await importGitHubTask(required('state'), (values.issue !== undefined ? numberOption('issue', { min: 1 }) : Number(positionals[1])), { actor: actor(), ...onBehalfOf(), ...authorityRef() })); break;
    case 'config': {
      assert(['update', 'show'].includes(positionals[1]), 'use config update or config show');
      // config show prints the configuration in force, including live settings changed from the console.
      if (positionals[1] === 'show') { const store = new Store(required('state')); try { print(configWithModelDefaults(store)); } finally { store.close(); } break; }
      // --current re-applies the stored configuration, recompiling workflows with the current code. It
      // keeps every live change and its provenance as they are (the command reads what is stored).
      assert(!(values.current && (values.config !== undefined || values['replace-live'])), 'config update --current re-applies the stored configuration: pass neither --config nor --replace-live');
      const source = values.current ? { current: true } : { config: readJSON(required('config')), ...(values['replace-live'] ? { replaceLive: true } : {}) };
      // One JSON document on stdout: the receipt, with any guidance in its "messages" list.
      canonical('config.update', { ...source, note: required('note') }, configUpdateMessages);
      break;
    }
    case 'maintenance': { assert(positionals[1] === 'enqueue', 'use maintenance enqueue'); canonical('job.enqueue', { id: values.id ?? uid(), operation: required('operation'), payload: values.file ? readJSON(values.file) : JSON.parse(values.payload ?? '{}'), note: required('note') }); break; }
    case 'retention': {
      await exclusiveMaintenance(async store => {
        const preservation = () => readJSON(required('preservation'));
        if (positionals[1] === 'plan') { const result = retentionPlan(store, { artifactRoot: required('root'), candidates: readJSON(required('file')), preservation }); if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); print(result); }
        else { assert(positionals[1] === 'apply', 'use retention plan or apply'); print({ deleted: applyRetention(store, { manifest: readJSON(required('file')), approvedDigest: required('digest'), preservation }) }); }
      }, { obligations: 'all' }); break;
    }
    case 'upgrade': {
      if (positionals[1] === 'apply' && values.recover) {
        // --recover: finish a --merge or --activate that stopped partway, and nothing else.
        print(await recoverUpgrade({ root: required('root'), stateDir: required('state'), actor: actor(), ...onBehalfOf(), ...(values.release !== undefined ? { releaseDir: values.release, expectedDigest: required('digest') } : {}) })); break;
      } else if (positionals[1] === 'apply') {
        // --activate: the reviewed adoption already landed on the remote target through a PR; pull it
        // and recommission, without merging or pushing. Otherwise: prepare, or --merge the review branch.
        const options = values.activate ? { root: required('root'), stateDir: required('state'), expectedDigest: required('digest'), ...(values.release !== undefined ? { releaseDir: values.release } : {}), actor: actor(), ...onBehalfOf() } : { root: required('root'), stateDir: required('state'), releaseDir: required('release'), expectedDigest: required('digest'), branch: required('branch'), worktreeDir: required('worktree'), actor: actor(), ...onBehalfOf() };
        const apply = () => values.activate ? activateUpgrade({ ...options, backupDir: required('out') }) : !values.merge ? prepareUpgrade(options) : mergeUpgrade({ ...options, backupDir: required('out'), push: values.push });
        // --when-drained: pause admission so running work can finish, wait for the drain, apply,
        // then lift the pause it set. Run it in the background; it reports while it waits.
        if (values['when-drained']) {
          const limit = Date.now() + numberOption('max-wait-hours', { integer: false, min: 0, max: 8760, fallback: 72 }) * 3600000, HOLD = 'Holding new work so the upgrade';
          // The pause is the upgrade's own if this run set it or an earlier --when-drained run did
          // (its note says so); either way it is lifted when this run ends, however it ends.
          const reasons = () => { const store = new Store(options.stateDir); try { const last = store.db.prepare("SELECT payload FROM events WHERE type = 'admission.paused' ORDER BY sequence DESC LIMIT 1").get(); return { reasons: drainReasons(store), paused: store.meta('paused') === true, ours: Boolean(last && JSON.parse(last.payload).note?.startsWith(HOLD)) }; } finally { store.close(); } };
          // Hold from the start, whether or not work is running: nothing new, maintenance included,
          // may start between the drain check and the upgrade. An operator's own pause is kept.
          let state = reasons(), paused = true; const operatorPause = state.paused && !state.ours, requeue = [];
          canonical('pause', { paused: true, holdMaintenance: true, note: `${HOLD} to ${values.release} can apply when running work finishes` });
          const lift = () => { if (!paused) return true; paused = false; try { return canonical('pause', { paused: operatorPause, note: operatorPause ? 'Upgrade finished or stopped; the operator pause stays' : 'Upgrade finished or stopped; admission resumed' }).status === 'completed'; } catch { return false; } };
          for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { lift(); process.exit(130); });
          // A maintenance run that was stopped (for example by an earlier attempt stopping the
          // services) never drains by itself: abandon it and queue the same job after the upgrade.
          // (A knowledge-upkeep assessment is not queued from here: its receipt returns to pending
          // and the operations loop queues it again, with the deadline it already had.)
          const clearStoppedMaintenance = () => { const store = new Store(options.stateDir); let flows; try { flows = store.all('flow').filter(f => f.kind === 'maintenance' && f.state === 'stopped' && !f.attemptId).map(f => ({ id: f.id, operation: f.workflow?.nodes?.[f.workflow?.start]?.action?.operation })); } finally { store.close(); }
            for (const f of flows) if (canonical('flow.abandon', { flowId: f.id, note: 'Stopped maintenance run cleared so the upgrade can apply; it is queued again afterwards' }).status === 'completed' && f.operation && f.operation !== 'knowledge.upkeep') requeue.push(f.operation); };
          clearStoppedMaintenance(); state = reasons();
          while (state.reasons.length) {
            assert(Date.now() < limit, `still not drained after ${values['max-wait-hours'] ?? 72} h: ${state.reasons.join('; ')}`);
            console.error(`${new Date().toISOString()} waiting for drain: ${state.reasons.join('; ')}`);
            await new Promise(resolve => setTimeout(resolve, 60000)); clearStoppedMaintenance(); state = reasons();
          }
          let result;
          try { result = await apply(); }
          catch (error) { result = { ok: false, error: error.message }; }
          // A pause that could not be lifted is reported, never left silently.
          for (const operation of [...new Set(requeue)]) { try { canonical('job.enqueue', { operation, note: 'Queued again after the upgrade cleared its stopped run' }); } catch {} }
          if (requeue.length) result = { ...result, requeued: [...new Set(requeue)] };
          if (!lift()) result = { ...result, ok: false, pauseLeft: true, pauseNote: 'Admission is still paused by the upgrade hold; run command --operation pause --payload \'{"paused":false,"note":"…"}\'' };
          print(result); if (result.ok === false) process.exitCode = 1;
          break;
        }
        if (values.activate) { const result = await apply(); print(result); if (!result.ok) process.exitCode = 1; }
        else if (!values.merge) print(prepareUpgrade(options));
        else { const result = await mergeUpgrade({ ...options, backupDir: required('out'), push: values.push }); print(result); if (!result.ok) process.exitCode = 1; }
        break;
      }
      await exclusiveMaintenance(async store => {
        if (positionals[1] === 'stage') print(stageUpgrade(store, { sourceDir: required('source'), installRoot: required('install'), version: required('version'), compatibility: readJSON(required('compatibility')) }));
        else { assert(positionals[1] === 'activate', 'use upgrade apply, stage or activate'); const check = readJSON(required('verify')); assert(Number.isSafeInteger(check.timeoutMs ?? 120000) && (check.timeoutMs ?? 120000) > 0 && (check.timeoutMs ?? 120000) <= 600000, 'bounded verification timeout required'); assert(Array.isArray(check.argv) && check.argv.length && check.argv.every(v => typeof v === 'string'), 'verification argv required'); print(finishUpgrade(store, { version: required('version'), verify: cwd => { try { const before = installationDigest(cwd); execFileSync(check.argv[0], check.argv.slice(1), { cwd, timeout: check.timeoutMs ?? 120000, stdio: 'pipe' }); return before === installationDigest(cwd); } catch { return false; } } })); }
      }); break;
    }
    case 'service': {
      // Persistent systemd --user units: service install|uninstall project|console.
      const [action, kind] = positionals.slice(1);
      assert(['install', 'uninstall'].includes(action) && ['project', 'console'].includes(kind), 'use service install|uninstall project|console');
      if (kind === 'console') {
        if (action === 'install') print(await installUnit(consoleUnit({ cli: resolve(process.argv[1]), consoleState: required('state'), port: values.port === undefined ? undefined : String(numberOption('port', { max: 65535 })) }), { replace: values.replace, start: values.start }));
        else print(await uninstallUnit(unitName('console')));
        break;
      }
      const store = new Store(required('state')); let project;
      try { project = store.meta('project'); if (values.install) resolveInstallation(store, values.install); } finally { store.close(); }
      assert(project.supervisor === 'systemd', 'persistent services are supported for systemd-supervised projects');
      if (action === 'install') print(await installUnit(projectUnit({ project, stateDir: values.state, installRoot: values.install, socketPath: values.socket }), { replace: values.replace, start: values.start }));
      else print(await uninstallUnit(unitName('project', project.projectId)));
      break;
    }
    case 'cleanup': {
      // Preserved cleanup of a failed or abandoned flow's workspace, or a completed flow's whose cleanup failed: plan, apply (operator), restore.
      // archive-drop: remove the archives of proven, released flows (operator only); --id repeats.
      if (positionals[1] === 'archive-drop') {
        const flowIds = parseArgs({ args: process.argv.slice(2), allowPositionals: true, allowNegative: true, options: { ...OPTIONS, id: { type: 'string', multiple: true } } }).values.id ?? [];
        const selection = { flowIds, completed: values.completed };
        if (positionals[2] === 'plan') print(await archiveDropPlan(required('state'), selection));
        else { assert(positionals[2] === 'apply', 'use cleanup archive-drop plan or apply'); print(await archiveDropApply(required('state'), { ...selection, planDigest: required('digest'), note: required('note'), actor: actor(), ...onBehalfOf() })); }
        break;
      }
      const flowId = required('id');
      if (positionals[1] === 'plan') print(await cleanupPlan(required('state'), flowId));
      else if (positionals[1] === 'apply') print(await cleanupApply(required('state'), { flowId, planDigest: required('digest'), note: required('note'), actor: actor(), ...onBehalfOf() }));
      else { assert(positionals[1] === 'restore', 'use cleanup plan, apply, restore or archive-drop'); print(restoreFlowArchive(required('state'), flowId, resolve(required('out')))); }
      break;
    }
    case 'workflow': {
      // export: the reference graph for this project's configuration, as a starting point for a project-owned copy.
      // list: the commissioned catalog, its pinned sources and any drift on disk.
      const store = new Store(required('state'));
      try {
        const config = validateConfig(store.meta('config')), catalog = store.meta('catalog');
        if (positionals[1] === 'export') { const graph = referenceWorkflow(values.from ?? 'change.standard', config); if (values.out) writeFileSync(values.out, JSON.stringify(graph, null, 2) + '\n'); else print(graph); }
        else { assert(positionals[1] === 'list', 'use workflow export or workflow list'); print(catalog ? { selection: catalog.selection, workflows: Object.values(catalog.workflows).map(({ name, digest, source }) => ({ name, digest, source })), drift: catalogDrift(catalog, store.meta('project').root) } : { catalog: null, workflow: config.mode === 'delivery' ? 'change.standard (supplied reference)' : 'rehearsal graph', workflowDigest: store.meta('workflowDigest') }); }
      } finally { store.close(); }
      break;
    }
    case 'status': {
      // Default: the whole snapshot, unchanged. --compact: what the service socket serves the console.
      // --inbox/--flow/--task: one item, flow or task with the holds needed to act on it.
      const narrow = ['inbox', 'flow', 'task'].filter(key => values[key] !== undefined);
      assert(!(values.compact && narrow.length), 'use --compact or --inbox/--flow/--task, not both');
      const store = new Store(required('state'));
      // --compact prints one line of JSON (dev.85, I5c): it is read by programs (jq, the triage proxy), and the indentation was a quarter of its size.
      try { if (values.compact) console.log(JSON.stringify(publicValue(store, dashboardSnapshot(store)))); else print(narrow.length ? stateView(store, { inbox: values.inbox, flow: values.flow, task: values.task }) : snapshot(store)); } finally { store.close(); }
      break;
    }
    case 'command': {
      // A maintenance operation sent as a command gets the right route, not "unsupported".
      if (MAINTENANCE_OPERATIONS.includes(values.operation)) { console.error(commandHelp(values.operation).text); process.exitCode = 1; break; }
      const store = new Store(required('state'));
      try {
        const receipt = executeCommand(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId: values.id ?? uid(), operation: required('operation'), payload: values.file ? readJSON(values.file) : JSON.parse(values.payload ?? '{}'), actor: actor(), ...onBehalfOf(), ...authorityRef() });
        print(receipt); if (receipt.status === 'rejected') process.exitCode = 1;
      } finally { store.close(); }
      break;
    }
    case 'launch': {
      const store = new Store(required('state')); let installed;
      try { installed = resolveInstallation(store, required('install')); } finally { store.close(); }
      const child = spawn(process.execPath, [installed.entry, 'serve', '--state', resolve(values.state), ...(values.socket ? ['--socket', values.socket] : [])], { stdio: 'inherit' });
      const forward = signal => { try { child.kill(signal); } catch {} };
      const term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT'); process.once('SIGTERM', term); process.once('SIGINT', interrupt);
      await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { process.off('SIGTERM', term); process.off('SIGINT', interrupt); process.exitCode = code ?? (signal ? 1 : 0); done(); }); }); break;
    }
    case 'serve': {
      const stateDir = resolve(required('state'));
      const service = await startProjectService({ stateDir, socketPath: values.socket ?? join(stateDir, 'project.sock') });
      print({ socketPath: service.socketPath, projectId: service.store.meta('project').projectId });
      shutdown(service.close); break;
    }
    case 'console': {
      const consoleServer = await startConsole({ stateDir: required('state'), port: numberOption('port', { max: 65535, fallback: 0 }) });
      print({ url: consoleServer.url }); shutdown(consoleServer.close); break;
    }
    case 'register': print(await registerProject(required('state'), { socketPath: required('socket') })); break;
    case 'unregister': print(await unregisterProject(required('state'), required('project'))); break;
    case 'backup': print(backupProject(required('state'), required('out'))); break;
    case 'restore': print(restoreProject(required('from'), required('state'))); break;
    case 'authority': {
      // Offline schema migration for the decision-authority ledger: preview is read-only; migrate
      // needs a stopped runner, a drained project and a new backup directory (the only rollback).
      if (positionals[1] === 'preview') { const result = previewAuthorityMigration(required('state')); print(result); if (result.status === 'blocked') process.exitCode = 1; }
      else if (positionals[1] === 'migrate') {
        // Withheld from adopters: no release yet declares schema 2, so a migrated project could not
        // be upgraded or launched by any published release. Require an explicit opt-in.
        assert(values['unreleased-schema'], 'authority migrate is not yet released for adopters: no published release supports the migrated schema, so a migrated project could not be upgraded. Use --unreleased-schema only for development or qualification state.');
        print(await applyAuthorityMigration(required('state'), { backupDir: required('out') }));
      }
      else { assert(positionals[1] === 'status', 'use authority preview, migrate or status'); const store = new Store(required('state')); try { print(authorityStatus(store)); } finally { store.close(); } }
      break;
    }
    case 'layout': {
      // Record layout of the state database (docs/running.md): status is read-only; migrate and
      // inline need the project runner stopped. The service migrates by itself when it starts.
      if (positionals[1] === 'migrate') print(await migrateLayout(required('state')));
      else if (positionals[1] === 'inline') print(await inlineLayout(required('state')));
      else { assert(positionals[1] === 'status', 'use layout status, migrate or inline'); print(layoutStatus(required('state'))); }
      break;
    }
    default: console.log(`Factotum 0.2 — reference implementation\n\nCommands: release build, adopt install/plan/update/status/cleanup, init, doctor, workflow export/list, service install/uninstall project|console, cleanup plan/apply/restore/archive-drop, import-task, reconcile, config update/show, maintenance enqueue, serve, status, command, console, register, unregister, backup, restore, authority preview/migrate/status, layout status/migrate/inline, launch, retention plan/apply, upgrade apply/stage/activate\nAdd --help after any command (and its action) for its usage and options, e.g. config update --help.\nSee README.md and docs/running.md for the evaluated path.\nAll state paths must be explicit and outside project checkouts.`);
  }
}
function installationDigest(root) {
  const walk = (path, prefix = '') => readdirSync(path).sort().flatMap(name => { const file = join(path, name), stat = lstatSync(file); assert(!stat.isSymbolicLink(), 'installed symlinks unsupported'); return stat.isDirectory() ? walk(file, prefix + name + '/') : [[prefix + name, fileDigest(file)]]; });
  return digest(walk(root));
}
// --instruction records that the orchestrator acts on an operator instruction.
function onBehalfOf() { return values.instruction ? { onBehalfOf: { principal: 'operator', instruction: values.instruction, ...(values.reference ? { reference: values.reference } : {}) } } : {}; }
// --authority '{"grantId":"…","entryId":"…","expectedVersion":N}' cites one stored operator grant entry (migrated projects).
function authorityRef() { return values.authority ? { authority: JSON.parse(values.authority) } : {}; }
function canonical(operation, payload, messages) {
  const store = new Store(required('state'));
  try { const receipt = executeCommand(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId: values.id ?? uid(), actor: actor(), operation, payload, ...onBehalfOf(), ...authorityRef() }); const notes = messages?.(receipt, store.meta('project')) ?? []; print(notes.length ? { ...receipt, messages: notes } : receipt); if (receipt.status === 'rejected') process.exitCode = 1; return receipt; } finally { store.close(); }
}
function configUpdateMessages(receipt, project) {
  const result = receipt.result ?? {}, messages = [];
  for (const row of result.keptLiveDetails ?? []) messages.push(`Kept live setting ${row.setting} = ${JSON.stringify(row.liveValue)}: changed live by the ${row.changedBy ?? 'unknown actor'}${row.onBehalfOf ? ' for the operator' : ''}${row.changedAt ? ` at ${row.changedAt}` : ''}${row.fileChanged === true ? `; the file also changed it (to ${JSON.stringify(row.fileValue)}), which was not applied` : row.fileChanged === false ? '; the file did not change it' : `; the file has ${JSON.stringify(row.fileValue)}`}.`);
  if (result.keptLiveDetails?.length) messages.push('Pass --replace-live to take the file’s values instead, or change a kept setting live with settings.update; config show prints the settings in force.');
  // A live setting this update changed (dev.88 M1): never silent, and named with its last live change.
  for (const row of result.changedLiveDetails ?? []) messages.push(`Live setting ${row.setting} changed from ${JSON.stringify(row.from)} to ${JSON.stringify(row.to)}${row.lastLiveChange ? `; it was last changed live to ${JSON.stringify(row.lastLiveChange.value)} by the ${row.lastLiveChange.by ?? 'unknown actor'}${row.lastLiveChange.onBehalfOf ? ' for the operator' : ''} at ${row.lastLiveChange.at}` : ''}.`);
  if (result.changedLiveDetails?.some(row => row.lastLiveChange)) messages.push('If a live change named above should stay, set it again with settings.update, or put its value in your configuration file. docs/operations.md, "Live settings after an upgrade", shows how to find live changes an earlier upgrade lost.');
  if (result.preservedLiveSettings?.length) messages.push(`Kept the live changes to ${result.preservedLiveSettings.join(', ')} as live changes: a later config update from your file keeps them.`);
  if (result.notificationBacklog) messages.push(`Notification delivery starts now: ${result.notificationBacklog.kept} open item(s) will be delivered; ${result.notificationBacklog.superseded} older delivery(ies) for settled items or past state events were superseded, not sent.`);
  if (receipt.status === 'completed') messages.push(`Commissioning cleared: admission, queue dispatch and planning are held until doctor passes for this configuration. Run: ${cliCommand(project?.root)} doctor --state ${values.state}`);
  return messages;
}
// Retention needs every obligation resolved; doctor and upgrades carry ordinary follow-ups over.
async function exclusiveMaintenance(fn, { obligations = 'blocking' } = {}) {
  const store = new Store(required('state')), lock = createServer(); let owned = false;
  try {
    await new Promise((resolveLock, reject) => { lock.once('error', () => reject(new Error('stop the live project runner before exclusive maintenance'))); lock.listen(`\0factotum-runner-${store.meta('project').projectId}`, () => { owned = true; resolveLock(); }); });
    assert(!store.live('flow').some(f => blocksDrain(store, f)), 'drain or explicitly abandon all flows before maintenance');
    assert(store.live('attempt').every(a => a.settledAt || ['passed', 'failed', 'not-dispatched', 'aborted'].includes(a.status)), 'reconcile all unresolved attempts before maintenance');
    const obligationReasons = drainReasons(store, { obligations }).filter(reason => reason.startsWith('resolve outstanding')); assert(!obligationReasons.length, `${obligationReasons[0]} before maintenance`);
    await fn(store);
  } finally { if (owned) await new Promise(resolveClose => lock.close(resolveClose)); store.close(); }
}
function shutdown(close) {
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; try { await close(); } catch (error) { console.error(error.message); process.exitCode = 1; } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
