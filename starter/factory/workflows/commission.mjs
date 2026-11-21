import { notificationConfigWarnings } from '../operations/notifications.mjs';
import { remoteRefHead } from '../core/git-options.mjs';
import { withGitHubGitScope, prepareGitInvocation, hasGitHubGitScope, scopedGitEnvironment } from '../adapters/github/git.mjs';
import { setTargetHealth } from '../operations/targets.mjs';
import { compileCatalog, commissionedGraphs } from '../core/catalog.mjs';
import { modelDefaults, modelSettingsVersion, modelSettingsView, selectFlowModels } from '../operations/model-settings.mjs';
import { unitDiagnostics } from '../operations/services.mjs';
import { probeAttemptEnvironment } from '../operations/attempt-environment-probe.mjs';
import { adoptionCheck } from '../distribution.mjs';
import { readAnchor, recordAuthentication } from '../core/adoption-anchor.mjs';
import { inspectGhBinary } from '../adapters/github/environment.mjs';
import { Store } from '../core/store.mjs';
import { validateConfig } from '../core/configuration.mjs';
import { assert, digest, now, uid } from '../core/contracts.mjs';
import { executeCommand, blocksDrain } from '../core/project.mjs';
import { createGitHub, createGhTransport } from '../adapters/github/index.mjs';
import { preflight, runProcess, ProviderError, PREFLIGHT_CALL_TIMEOUT_MS, PREFLIGHT_CALLS, codexSandboxSpawnProbe } from '../adapters/providers/index.mjs';
import { knownSecrets } from '../operations/known-secrets.mjs';
import { outputExcerpt } from '../core/command-failure.mjs';
import { redactSecretText, redactSecretValues } from '../core/redact.mjs';
import { SETUP_TIMEOUT_MS } from '../adapters/workspace/index.mjs';
import { HostResources, resourceRequest, describeHolders, LEASE_HOLD_BOUND_MS } from '../operations/resources.mjs';
import { processIdentity } from '../core/process-identity.mjs';
import { assembleContext } from '../operations/context.mjs';
import { runMaintenanceAction } from './maintenance.mjs';
import { join, dirname, relative, resolve, isAbsolute, posix, sep } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { upgradeOwned } from '../core/install-layout.mjs';
import { upkeepOn } from '../core/upkeep-config.mjs';
import { upkeepSelectionConfig } from '../operations/upkeep-route.mjs';
import { namespaceCollisionReasons } from '../operations/upkeep-records.mjs';
import { fileURLToPath } from 'node:url';
import { validateIssueProfile, dependencyNumber } from '../adapters/github/issue-profile.mjs';
// The operator checkout must hold no work of its own: clean (checked above) and contained in the
// remote target. Being behind is fine for commissioning: deliveries run in owned worktrees from
// the remote target and main checks run on the remote head. Two things do run from the checkout:
// the service runs its factory/cli.mjs, and source and integration adapters run their scripts from
// it. So a checkout behind on the installed factory files (or the release lock), or on a file the
// configuration runs from the checkout, is refused, since it would run older code than the target
// records; behind on anything else, commands run in workspaces from the target included, is a
// warning naming how far behind it is (configuredCommandLocations).
const FACTORY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The installed, upgrade-owned paths, relative to the checkout: the recorded installation (the lock,
// <prefix>/factory/, <prefix>/VERSION and <prefix>/compatibility.json; with no lock, factory/ and the
// lock path), plus the folder this code runs from when it is inside the checkout. A prefixed
// project's own root factory/ folder is not among them.
function factoryPaths(root) {
  let inside = null; try { const rel = relative(realpathSync(root), realpathSync(FACTORY_DIR)); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) inside = rel; } catch {}
  const owned = upgradeOwned(realpathSync(root));
  return [...new Set([inside, ...owned.dirs.map(dir => dir.slice(0, -1)), ...owned.files, owned.lock].filter(Boolean))];
}
// Repository files the configuration runs as commands: every argument of every argv/command
// list (gate, fast and main checks, preview, scheduled tasks, source and integration adapters),
// each workspace.setup command, and the implementation `files` an adapter declares. Every command
// runs with a checkout of the repository as its working directory, so a relative argument is
// resolved against the repository root and an absolute one against its real path; a path that
// leaves the repository is not a repository file. Each argument is taken whole (paths may contain
// spaces) and also split into shell words, honouring sh quoting and escapes (for `sh -c "…"`
// strings), and at = and , (for `--opt=value`). Inline interpreter code (`node -e`, `python -c`)
// is not scanned. A word is
// a candidate when it has a slash or a file extension. Variables (`$X`, `${X}`) and `~` cannot be
// resolved here, so they fail safe: a leading one is dropped and the rest taken as a repository
// path, an inner one becomes a wildcard. Results may contain * and ? wildcards (see
// commandPathMatches); a directory covers the files under it.
const VALUE_SPLIT = /[=,]+/;
const INLINE_CODE = /^(?:-e|--eval|-p|--print|-c)$/;
const INTERPRETER = /^(?:node|nodejs|deno|bun|python[0-9.]*|ruby|perl|php)$/;
// Split one string into shell words the way sh would: whitespace and ; & | ( ) < > ` separate
// words; single quotes are literal; double quotes keep spaces and honour backslash escapes; a
// backslash outside quotes escapes the next character. Unbalanced quotes take the rest literally.
function shellWords(text) {
  const words = []; let word = '', inWord = false, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') { if (c === '"') quote = null; else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) word += text[++i]; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < text.length) { word += text[++i]; inWord = true; continue; }
    if (/[\s;&|()<>`]/.test(c)) { if (inWord) words.push(word); word = ''; inWord = false; continue; }
    word += c; inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}
const GLOB = /[*?[\]]/;
// Where each configured command runs (dev.84, H13). These sections run only in a factory workspace
// created from the target (or from the candidate built on it), never from the operator checkout:
// gate checks (`checks`) and fast checks in the flow's worktree, main checks and scheduled tasks
// in an owned checkout of the target's remote head, `preview` on the candidate, and
// `workspace.setup` in each new worktree. A relative path in them names the workspace's copy, which
// is the target's (or candidate's) current file, so a checkout that is behind does not change what
// they run. Everything else runs with the operator checkout as its working directory (source and
// integration adapters and their implementation `files`, the retention preservation adapter,
// project-owned workflow commands, and any section not listed here: fail safe). A path that is
// absolute, or starts with a variable or ~, may point into the operator checkout whatever the
// section, so it counts as run from the checkout.
const WORKSPACE_SECTIONS = new Set(['checks', 'fastChecks', 'mainChecks', 'workspace', 'preview', 'scheduledTasks']);
export function configuredCommandLocations(config, root) {
  const lists = [], seen = { checkout: new Set(), workspace: new Set() };
  const visit = (value, key, place) => {
    if (Array.isArray(value)) {
      if (['argv', 'command'].includes(key) && value.every(item => typeof item === 'string')) { lists.push([value, place]); return; }
      if (key === 'setup') for (const item of value) if (Array.isArray(item) && item.every(x => typeof x === 'string')) lists.push([item, place]);
      for (const item of value) visit(item, key, place);
    } else if (value && typeof value === 'object') {
      if (Array.isArray(value.argv) && Array.isArray(value.files)) for (const file of value.files) if (typeof file?.path === 'string') lists.push([[file.path], place]);
      for (const [name, item] of Object.entries(value)) visit(item, name, place);
    }
  };
  if (config && typeof config === 'object') for (const [name, value] of Object.entries(config)) visit(value, name, WORKSPACE_SECTIONS.has(name) ? 'workspace' : 'checkout');
  let realRoot = resolve(root); try { realRoot = realpathSync(root); } catch { /* not on disk: the given path only */ }
  const add = (word, whole, place) => {
    if (!word || (!whole && word.startsWith('-'))) return;
    let path = word.replace(/^(?:\$\{?\w+\}?|~)(?=\/)/, '').replace(/\$\{?\w+\}?/g, '*');
    if (!whole && !(path.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(path) || GLOB.test(path))) return;
    if (whole && (/[;&|()<>'"`=]/.test(path) || !(path.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(path)))) return;
    // A path written absolute, or behind a variable or ~, may name the operator checkout's copy.
    const anchored = isAbsolute(path) || path !== word && /^(?:\$|~)/.test(word);
    if (isAbsolute(path) && path !== word) path = path.slice(1); // a variable stood for the repository (fail safe)
    let rel;
    if (isAbsolute(path)) { const target = posix.normalize(path); rel = [realRoot, resolve(root)].map(base => relative(base, target).split(sep).join('/')).find(row => row && !row.startsWith('../') && row !== '..' && !isAbsolute(row)); if (!rel) return; }
    else rel = posix.normalize(path);
    rel = rel.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return;
    seen[anchored ? 'checkout' : place].add(rel);
  };
  for (const [argv, place] of lists) argv.forEach((arg, index) => {
    add(arg, true, place);
    // Inline program text for an interpreter (`node -e '…'`, `python -c '…'`) is code, not a
    // command line: names in it are strings the program prints or reads, so they are not scanned.
    if (index > 0 && INLINE_CODE.test(argv[index - 1]) && INTERPRETER.test(argv[0].split('/').pop())) return;
    for (const word of shellWords(arg)) for (const part of word.split(VALUE_SPLIT)) if (part !== arg) add(part, false, place);
  });
  // A file named in both places counts as run from the checkout.
  const checkout = [...seen.checkout];
  return { checkout, workspace: [...seen.workspace].filter(path => !seen.checkout.has(path)) };
}
// Every repository file the configuration runs as a command, wherever it runs.
export function configuredCommandPaths(config, root) {
  const { checkout, workspace } = configuredCommandLocations(config, root);
  return [...checkout, ...workspace];
}
// Whether a changed repository file is one of configuredCommandPaths: the path itself, a file
// under it, or a match of its wildcards (* and ? within one path segment, ** across segments).
export function commandPathMatches(file, path) {
  if (!GLOB.test(path)) return file === path || file.startsWith(`${path}/`);
  const pattern = path.split(/(\*\*|\*|\?)/).map(part => part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${pattern}(?:/.*)?$`).test(file);
}
export async function operatorCheckout(runGit, root, remoteName, target, config = {}) {
  const git = (args, timeoutMs = 10000) => runGit(args, { cwd: root, env: process.env, timeoutMs });
  const local = await git(['rev-parse', 'HEAD']), remote = await git(['ls-remote', remoteName, `refs/heads/${target}`], 30000);
  const head = local.stdout.trim(), remoteHead = remoteRefHead(remote.stdout, `refs/heads/${target}`);
  if (local.code !== 0 || remote.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(head) || !/^[a-f0-9]{40,64}$/i.test(remoteHead)) return { reason: `could not read the local root or ${remoteName}/${target}` };
  if (head === remoteHead) return { head, remoteHead, behind: 0 };
  // Fetch only the remote-tracking ref, so the comparison has the remote commits; the checkout's
  // branch, index and files are never changed.
  const trackingRef = `refs/remotes/${remoteName}/${target}`;
  const fetched = await git(['fetch', '--no-tags', remoteName, `+refs/heads/${target}:${trackingRef}`], 60000);
  if (fetched.code !== 0) return { reason: `could not fetch ${remoteName}/${target} to compare the local root with it` };
  const fetchedHead = (await git(['rev-parse', '--verify', `${trackingRef}^{commit}`])).stdout.trim();
  if (fetchedHead !== remoteHead) return { reason: `${remoteName}/${target} moved while doctor compared the local root with it; rerun doctor` };
  const ancestor = await git(['merge-base', '--is-ancestor', head, remoteHead]);
  if (ancestor.code !== 0) return { reason: `the local root has commits that are not on ${remoteName}/${target}; push or move that work off the operator checkout` };
  const count = await git(['rev-list', '--count', `${head}..${remoteHead}`]), behind = Number(count.stdout.trim());
  let paths; try { paths = factoryPaths(root); } catch (error) { return { reason: `could not read the installation layout: ${error.message}` }; }
  const changed = await git(['diff', '--name-only', head, remoteHead, '--', ...paths]);
  if (changed.code !== 0) return { reason: 'could not compare the local root with the remote target' };
  const factoryFiles = changed.stdout.split('\n').filter(Boolean);
  const pull = `git -C ${root} pull --ff-only`;
  if (factoryFiles.length) return { reason: `the local root is ${behind} commit(s) behind ${remoteName}/${target}, including installed factory files (${factoryFiles.slice(0, 5).join(', ')}${factoryFiles.length > 5 ? ', …' : ''}); the service would run an older factory than the target records. With work drained, run ${pull}, then doctor`, head, remoteHead, behind };
  const all = (await git(['diff', '--name-only', head, remoteHead])).stdout.split('\n').filter(Boolean);
  const list = files => `${files.slice(0, 5).join(', ')}${files.length > 5 ? `, and ${files.length - 5} more` : ''}`;
  // Only files run from the checkout itself matter (configuredCommandLocations): a command that runs
  // in a workspace created from the target uses the target's copy.
  const located = configuredCommandLocations(config, root), matches = paths => file => paths.some(path => commandPathMatches(file, path));
  const commands = all.filter(matches(located.checkout)), inWorkspaces = all.filter(file => !commands.includes(file) && matches(located.workspace)(file));
  if (commands.length) return { reason: `the local root is ${behind} commit(s) behind ${remoteName}/${target}, including files the configuration runs as commands from the operator checkout (${list(commands)}: source or integration adapters, or other commands that run there); commands run from the checkout would be older than the target records. Run ${pull}, then doctor`, head, remoteHead, behind };
  const workspaceNote = inWorkspaces.length ? `; ${inWorkspaces.length} changed file(s) are run by the configuration only in factory workspaces created from the target (gate, fast and main checks, preview, scheduled tasks, workspace.setup), which use the target's current copy (${list(inWorkspaces)})` : '';
  return { warning: `the local root is ${behind} commit(s) behind ${remoteName}/${target}; no factory files or ${inWorkspaces.length ? 'files the configuration runs from the checkout' : 'configured command files'} differ, so commissioning does not need it current${workspaceNote}${all.length ? ` (changed there: ${list(all)})` : ''}. Workflow files compiled by config update stay at the older version until ${pull}`, head, remoteHead, behind, ...(inWorkspaces.length ? { workspaceCommandFiles: inWorkspaces.length } : {}) };
}
// Provider probes (dev.85). A probe that fails on a timeout or a transient process error is tried
// once more, after PROBE_RETRY_PAUSE_MS; an auth, configuration, missing-CLI or invalid-result
// failure is not. A failure is named: the route, provider and model, what kind of failure it was,
// which CLI call failed, and a bounded, redacted excerpt of the error and the CLI's stderr.
export const PROBE_ATTEMPTS = 2, PROBE_RETRY_PAUSE_MS = 2000;
const PROBE_FAILURES = { timeout: 'timed out', 'process-error': 'process error', 'missing-cli': 'CLI missing', auth: 'auth problem', 'invalid-result': 'invalid result', configuration: 'configuration problem', error: 'unexpected error' };
const TRANSIENT_PROBE_FAILURES = new Set(['timeout', 'process-error']);
export function probeFailure(error, secrets = []) {
  const failure = PROBE_FAILURES[error?.failure] ? error.failure
    : error?.code === 'TIMEOUT' ? 'timeout'
    : error?.code === 'BILLING_UNVERIFIED' ? 'auth'
    : error?.code === 'PREFLIGHT_FAILED' ? 'process-error'
    : error instanceof ProviderError ? 'configuration'
    : 'error';
  // The auth call's output is never reported (it can name the account), whoever raised the error.
  const authCall = error?.call === 'auth status' || error?.failure === 'auth' || error?.code === 'BILLING_UNVERIFIED';
  const text = [error?.message ?? String(error), !authCall && typeof error?.stderr === 'string' && error.stderr.trim() ? `stderr: ${error.stderr}` : ''].filter(Boolean).join('\n');
  return { failure, transient: TRANSIENT_PROBE_FAILURES.has(failure), ...(typeof error?.call === 'string' ? { call: error.call } : {}), error: outputExcerpt(text, secrets) };
}
// The roles doctor probes, in order, and the distinct step model overrides (separate provider routes).
const probedRoles = config => ['planner', 'builder', 'reviewer', ...['auditor', 'reader', 'scoreboardOwner', 'upkeep'].filter(role => config.providers[role])];
function stepRoutes(store, config) {
  const graphs = commissionedGraphs(store), steps = modelSettingsView(store).filter(row => row.source !== 'role'), seen = new Set(), routes = [];
  for (const row of steps) {
    const spec = selectFlowModels(upkeepSelectionConfig(store, config), row.workflow, graphs[row.workflow], modelDefaults(store)).modelRoutes[row.step], key = `${row.role}:${spec.provider}:${spec.model}:${spec.effort ?? ''}`;
    if (seen.has(key)) continue; seen.add(key); routes.push({ row, spec });
  }
  return routes;
}

// The longest doctor can legitimately run (dev.85): the heavy permit wait (LEASE_HOLD_BOUND_MS),
// every provider probe at its full bound and retried once, the main verification workspace's setup
// commands at their timeout (workspace.setupTimeoutMs, by default SETUP_TIMEOUT_MS each), every main
// check at its timeout and retries, and DOCTOR_MARGIN_MS for the Git and forge calls around them
// (each bounded by its own timeout; the margin covers their sum with room to spare). `upgrade apply`
// gives its doctor child this long, capped at DOCTOR_TIME_CAP_MS, so it never cuts doctor off
// inside doctor's own bounds unless the configuration's checks and setup alone exceed the cap
// (`capped` says so). A state that cannot be read gets the estimate for three roles, no setup and
// no checks.
export const DOCTOR_MARGIN_MS = 15 * 60_000, DOCTOR_TIME_CAP_MS = 4 * 3_600_000;
export const PROBE_BOUND_MS = PREFLIGHT_CALLS * (PREFLIGHT_CALL_TIMEOUT_MS + 1000);
export function doctorTimeBound(stateDir, { resourceWaitMs = LEASE_HOLD_BOUND_MS } = {}) {
  let probes = 3, checksMs = 0, setupMs = 0;
  try {
    const store = new Store(stateDir);
    try {
      const config = store.meta('config') ?? {};
      if (config.providers) probes = probedRoles(config).reduce((count, role) => count + 1 + (config.providers[role]?.allowFallback && config.providers[role]?.fallback ? 1 : 0), 0);
      try { probes += stepRoutes(store, config).length; } catch { /* doctor reports it; no step routes to count */ }
      const retries = Number.isSafeInteger(config.policy?.mainInfrastructureRetries) ? Math.min(Math.max(config.policy.mainInfrastructureRetries, 0), 2) : 0;
      for (const check of Array.isArray(config.mainChecks) ? config.mainChecks : []) if (Number.isSafeInteger(check?.timeoutMs) && check.timeoutMs > 0) checksMs += (check.timeoutMs + 1000) * (1 + retries + Math.min(Number.isSafeInteger(check.flakePolicy?.retries) ? check.flakePolicy.retries : 0, 2));
      const setup = Array.isArray(config.workspace?.setup) ? config.workspace.setup.length : 0, perCommand = Number.isSafeInteger(config.workspace?.setupTimeoutMs) && config.workspace.setupTimeoutMs > 0 ? config.workspace.setupTimeoutMs : SETUP_TIMEOUT_MS;
      setupMs = setup * (perCommand + 1000);
    } finally { store.close(); }
  } catch { /* unreadable state: the default estimate */ }
  const probesMs = probes * (PROBE_ATTEMPTS * PROBE_BOUND_MS + PROBE_RETRY_PAUSE_MS);
  const totalMs = resourceWaitMs + probesMs + setupMs + checksMs + DOCTOR_MARGIN_MS;
  return { timeoutMs: Math.min(totalMs, DOCTOR_TIME_CAP_MS), capped: totalMs > DOCTOR_TIME_CAP_MS, parts: { permitWaitMs: resourceWaitMs, probes, probesMs, setupMs, mainChecksMs: checksMs, marginMs: DOCTOR_MARGIN_MS } };
}

export async function doctor(stateDir, options = {}) {
  if (!options.forgeTransport && (!options.run || options.run === runProcess) && !hasGitHubGitScope()) {
    const source = new Store(stateDir); let repository;
    try { repository = source.meta('config')?.repository; } finally { source.close(); }
    if (repository) {
      try { return await withGitHubGitScope(repository, () => doctorScoped(stateDir, options)); }
      catch { const failed = new Store(stateDir); try { return failed.tx(() => { const record = { ready: false, configDigest: failed.meta('configDigest'), checkedAt: now(), providers: {}, reasons: ['account-pinned GitHub transport qualification failed'] }; failed.setMeta('commissioning', record); failed.event('project.doctor', { ready: false, reasons: record.reasons }); return record; }); } finally { failed.close(); } }
    }
  }
  return doctorScoped(stateDir, options);
}
// onProgress(phase, detail) is told as doctor enters each long phase (the CLI prints it as
// "doctor: [<phase>] <detail>", which upgrade apply reads back to say where a doctor it ran stopped):
// "permit wait", "probe of <route> (<provider>/<model>)", "forge check", "checkout check" and
// "main verification"; with the real providers also "attempt environment check".
export const doctorProgressLine = (phase, detail = '') => `doctor: [${phase}] ${detail}`.trimEnd();
// sandboxProbe: the offline Codex sandbox check (dev.91, O2). It runs the real `codex sandbox` only with
// the real provider preflight; a caller that fakes the providers gives its own or none.
// attemptEnvironmentProbe: whether an attempt unit resolves the service's node and git (dev.104,
// operations/attempt-environment-probe.mjs). Like the sandbox check, it starts a real transient unit
// only with the real provider preflight; a caller that fakes the providers gives its own or none.
async function doctorScoped(stateDir, { providerPreflight = preflight, sandboxProbe = providerPreflight === preflight ? codexSandboxSpawnProbe : null, attemptEnvironmentProbe = providerPreflight === preflight ? probeAttemptEnvironment : null, forgeTransport, run = runProcess, resourceWaitMs = LEASE_HOLD_BOUND_MS, onResourceWait, onProgress, retryPauseMs = PROBE_RETRY_PAUSE_MS } = {}) {
  // Every string doctor reports (progress, reasons, warnings, provider entries, the event) is
  // redacted whole with the known secrets: the environment's until the configuration is read, then
  // the configuration's too. A route, provider or model that equals a secret is removed with it.
  let secrets = knownSecrets({});
  const progress = (phase, detail = '') => { try { onProgress?.(redactSecretText(phase, secrets), redactSecretText(detail, secrets)); } catch {} };
  const runGit = async (args, options) => { const prepared = await prepareGitInvocation(args, { cwd: options.cwd, env: options.env }); return run('git', prepared.args, { ...options, env: prepared.env }); };
  const store = new Store(stateDir); const checkedConfigDigest = store.meta('configDigest'), checkedModelVersion = modelSettingsVersion(store); const checkedAt = now(), reasons = [], warnings = [], providers = {}; let gh = {}; let config, mainHealth, codexSandbox = null, attemptEnvironment = null;
  try {
    assert(!store.live('flow').some(f => blocksDrain(store, f)), 'doctor requires drained or abandoned flows (task flows waiting on a question may stay)');
    assert(store.live('attempt').every(a => a.settledAt || ['passed','failed','not-dispatched','aborted'].includes(a.status)), 'doctor requires reconciled attempts');
    config = validateConfig(store.meta('config')); const project = store.meta('project'); secrets = knownSecrets(config);
    assert(config.mode === 'delivery', 'doctor requires delivery configuration');
    // Knowledge upkeep is on: no open task the factory did not make may sit in its reserved namespace
    // (a bounded read of a declared index; when it is not verified, that is the reason).
    if (upkeepOn(config)) { try { reasons.push(...namespaceCollisionReasons(store).map(reason => `knowledge upkeep is on (upkeep.mode): ${reason}`)); } catch (error) { reasons.push(error.message); } }
    validateIssueProfile(config.repository.issueProfile);
    assert(project.supervisor === 'systemd', 'delivery qualification requires contained systemd supervision');
    assert(Array.isArray(config.mainChecks) && config.mainChecks.length > 0, 'nonempty mainChecks required');
    for (const check of config.mainChecks) assert(check.id && Array.isArray(check.argv) && check.argv.length && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0, 'invalid main check');
    // Use the commit scope even when doctor transports are injected. A global
    // identity or ambient GIT_AUTHOR_* variables cannot supply factory identity.
    const identityKeys=['user.name','user.email'];
    const identity=await Promise.all(identityKeys.map(key=>runGit(['config','--get',key],{cwd:project.root,env:scopedGitEnvironment(process.env),timeoutMs:10000})));
    const missing=identityKeys.filter((key,i)=>identity[i].code!==0||!identity[i].stdout.trim());
    assert(!missing.length,`Git identity missing or empty in factory scope: ${missing.join(', ')}. Set each with git config --local; global configuration is ignored.`);
    reasons.push(...unitDiagnostics(project, stateDir));
    // Checks and providers must run the service's node and git, not the user manager's.
    if (attemptEnvironmentProbe) {
      progress('attempt environment check', 'which node and git an attempt unit runs');
      const probed = await attemptEnvironmentProbe({ project, stateDir, run });
      reasons.push(...probed.reasons); warnings.push(...probed.warnings); attemptEnvironment = probed.record;
    }
    // Running code must be the adopted release: an installed file that differs from the lock (edited,
    // missing, or rewritten on checkout by an attribute or smudge filter) blocks commissioning.
    // The stored root may reach the checkout through a symlinked folder; the check needs its real path.
    // A root lock written before dev.87 carries no layout evidence: accepted, with a warning until the next
    // adoption, unless the project's state records that its lock was authenticated by evidence before
    // (core/adoption-anchor.mjs). A lock verified by its evidence is recorded there the first time.
    { const adoption = adoptionCheck(realpathSync(project.root), { anchor: readAnchor(store) }); reasons.push(...adoption.reasons); warnings.push(...adoption.warnings); if (adoption.status) recordAuthentication(store, adoption.status); }
    // A pinned gh must be the real binary; an unpinned one that resolves to a shim or wrapper is a warning.
    gh = inspectGhBinary({ ghPath: config.repository.ghPath });
    if (config.repository.ghPath || !gh.path) reasons.push(...gh.problems); else warnings.push(...gh.problems.map(problem => `${problem}; set repository.ghPath to the real gh binary`));
    // Notification delivery is optional: a configuration file problem is a warning, never a reason.
    warnings.push(...notificationConfigWarnings(config));
    if (config.workflows) {
      try { const fresh = compileCatalog(config, project.root); if (fresh.digest !== store.meta('catalog')?.digest) reasons.push('workflow catalog on disk differs from the commissioned compilation; run config update'); }
      catch (error) { reasons.push(`workflow catalog invalid: ${error.message}`); }
    }
    assembleContext({ repoRoot: project.root, config: config.context ?? { files: [], maxChars: 24000 }, changedPaths: config.context?.files?.flatMap(f => f.paths ?? []) ?? [] });
    // One probe of a provider route: retried once on a timeout or transient process error. Returns
    // the preflight result and any failed first attempt, or throws an error carrying `probe`.
    const probe = async (route, spec, accept) => {
      const attempts = [];
      for (let attempt = 1; ; attempt++) {
        progress(`probe of ${route} (${spec.provider}/${spec.model})`, `attempt ${attempt} of ${PROBE_ATTEMPTS}`);
        try { const result = await providerPreflight(spec); accept(result); return { result, ...(attempts.length ? { retry: { attempts: attempts.length + 1, firstFailure: attempts[0].failure, firstError: attempts[0].error } } : {}) }; }
        catch (error) {
          const failed = probeFailure(error, secrets); attempts.push(failed);
          if (attempt < PROBE_ATTEMPTS && failed.transient) { await new Promise(resolve => setTimeout(resolve, retryPauseMs)); continue; }
          throw Object.assign(new Error(failed.error), { probe: { ...failed, attempts: attempts.length, retried: attempts.length > 1 } });
        }
      }
    };
    const described = (probeError) => { const { failure, call, error, attempts, retried } = probeError.probe ?? probeFailure(probeError, secrets); return { failure, ...(call ? { call } : {}), error, attempts: attempts ?? 1, retried: retried ?? false }; };
    const reasonFor = (label, spec, detail) => `${label} preflight failed for ${spec.provider}/${spec.model}: ${PROBE_FAILURES[detail.failure]}${detail.call ? ` during ${detail.call}` : ''}${detail.retried ? ', after one retry' : ''} (${detail.error.replace(/\s*\n+\s*/g, ' / ')})`;
    const capable = (result, what = 'provider required capability unavailable') => assert(result.billing?.mode === 'subscription' && result.capabilities?.structuredOutput === true && result.capabilities?.readOnly === true, what);
    for (const role of probedRoles(config)) {
      const selected = config.providers[role];
      let primary;
      try { primary = await probe(role, { ...selected, role, cwd: project.root, artifactDir: join(stateDir, 'doctor', role), prompt: 'Read-only preflight, do not launch a model.', timeoutMs: PREFLIGHT_CALL_TIMEOUT_MS }, capable); }
      catch (error) { const detail = described(error); providers[role] = { provider: selected.provider, model: selected.model, ready: false, phase: 'preflight', ...detail }; reasons.push(reasonFor(`${role} provider`, selected, detail)); continue; }
      providers[role] = { provider: selected.provider, model: selected.model, version: primary.result.version, billing: 'subscription', ready: true, ...(primary.retry ? { retry: primary.retry } : {}) };
      if (selected.allowFallback && selected.fallback) {
        const fallbackSpec = { ...selected, ...selected.fallback, role, cwd: project.root, artifactDir: join(stateDir, 'doctor', role, 'fallback'), prompt: 'Read-only fallback preflight.', timeoutMs: PREFLIGHT_CALL_TIMEOUT_MS, allowedModels: selected.fallback.allowedModels ?? selected.allowedModels };
        try { const fallback = await probe(`${role} fallback`, fallbackSpec, result => capable(result, 'fallback capability unavailable')); providers[role].fallback = { provider: selected.fallback.provider, model: selected.fallback.model, ready: true, ...(fallback.retry ? { retry: fallback.retry } : {}) }; }
        catch (error) { const detail = described(error); providers[role] = { ...providers[role], ready: false, phase: 'fallback preflight', fallback: { provider: fallbackSpec.provider, model: fallbackSpec.model, ready: false, ...detail } }; reasons.push(reasonFor(`${role} fallback provider`, fallbackSpec, detail)); }
      }
    }
    // Step model overrides are separate provider routes; preflight each distinct one.
    for (const { row, spec } of stepRoutes(store, config)) {
      const route = `${row.workflow}.${row.step}`;
      try { const probed = await probe(route, { ...spec, role: row.role, cwd: project.root, artifactDir: join(stateDir, 'doctor', 'steps', row.workflow, row.step), prompt: 'Read-only preflight, do not launch a model.', timeoutMs: PREFLIGHT_CALL_TIMEOUT_MS }, capable); providers[route] = { provider: spec.provider, model: spec.model, ready: true, ...(probed.retry ? { retry: probed.retry } : {}) }; }
      catch (error) { const detail = described(error); providers[route] = { provider: spec.provider, model: spec.model, ready: false, phase: 'preflight', ...detail }; reasons.push(reasonFor(`step model ${route}`, spec, detail)); }
    }
    // A Codex builder runs the project's commands inside Codex's workspace-write sandbox. On some hosts
    // that sandbox refuses part of process handling (Node's spawnSync and execSync fail with EPERM),
    // so the builder's own test runs fail there although the factory's checks, outside it, pass. Doctor
    // checks it offline (`codex sandbox`, no model) and warns; it never blocks commissioning (dev.91, O2).
    const codexBuilders = [config.providers.builder, config.providers.builder?.allowFallback ? config.providers.builder.fallback : null, ...stepRoutes(store, config).filter(({ row }) => row.role === 'builder').map(({ spec }) => spec)].filter(spec => spec?.provider === 'codex');
    if (codexBuilders.length && sandboxProbe) {
      progress('codex sandbox check', 'can Node start a child process inside the workspace-write sandbox');
      const dir = join(stateDir, 'doctor', 'codex-sandbox'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      let sandbox; try { sandbox = await sandboxProbe({ cwd: dir }); } catch (error) { sandbox = { spawn: 'unknown', detail: String(error?.message ?? error).slice(0, 300) }; }
      codexSandbox = sandbox;
      if (sandbox?.spawn === 'refused') warnings.push(`Codex's workspace-write sandbox on this host refuses part of process handling: Node's spawnSync with a piped stdin failed with ${sandbox.error} under codex sandbox. A Codex builder's own runs of project checks that start processes this way (node --test suites that spawn a CLI, execSync, …) fail inside its sandbox; the factory's fast checks, gate and main verification run outside it and decide. For a project whose checks start processes, prefer a Claude builder (providers.builder, or task.models for one task). See docs/running.md, "Codex builders and the sandbox"`);
      else if (sandbox?.spawn === 'unknown') warnings.push(`The Codex sandbox check could not run (${sandbox.detail ?? 'no detail'}); whether a Codex builder can run the project's process-starting checks inside its sandbox is unknown`);
    }
    progress('forge check', `GitHub repository ${config.repository.slug}`);
    const transport = forgeTransport ?? createGhTransport({ account: config.repository.account, hostname: config.repository.hostname, ghPath: config.repository.ghPath });
    const repo = await transport({ method: 'GET', path: `repos/${config.repository.slug}` }); assert(repo.permissions?.push === true, 'GitHub repository push permission required');
    if (config.policy?.autoMerge) {
      const protection = await createGitHub({ repository: config.repository.slug, account: config.repository.account, transport }).inspectProtection({ branch: config.repository.target, requiredContext: config.repository.checkContext ?? 'factotum/gate' });
      assert(protection.enforced && config.qualification?.qualified === true && config.qualification?.targetFreshness === 'strict-status', 'auto merge requires strict protection and explicit behavioral qualification');
    }
    const clean = await runGit(['status', '--porcelain'], { cwd: project.root, env: process.env, timeoutMs: 10000 }); assert(clean.code === 0 && !clean.stdout.trim(), 'project root must be clean for commissioning');
    progress('checkout check', `the local root against ${config.repository.remote ?? 'origin'}/${config.repository.target}`);
    const checkout = await operatorCheckout(runGit, project.root, config.repository.remote ?? 'origin', config.repository.target, config);
    if (checkout.reason) reasons.push(checkout.reason); else if (checkout.warning) warnings.push(checkout.warning);
    // Every other branch a workflow targets must exist on the remote.
    for (const target of [...new Set(Object.values(config.workflows?.definitions ?? {}).map(d => d.target).filter(t => t && t !== config.repository.target))]) {
      const other = await runGit(['ls-remote', config.repository.remote ?? 'origin', `refs/heads/${target}`], { cwd: project.root, env: process.env, timeoutMs: 30000 });
      assert(other.code === 0 && remoteRefHead(other.stdout, `refs/heads/${target}`), `workflow target branch ${target} does not exist on the remote`);
    }
    assert(config.resources?.coordinatorPath, 'doctor requires shared host resource coordinator');
    const coordinator = new HostResources(config.resources.coordinatorPath), attemptId = `doctor-${uid()}`, owner = processIdentity(); let lease;
    try {
      // Another project's heavy step may hold the shared permit for up to its own effect cap.
      // Wait that long (reporting who holds it), rather than failing commissioning on overlap.
      const request = resourceRequest(config, 'main.verify'), resource = request.resource ?? 'heavy-work', started = Date.now();
      let reported = null;
      while (!(lease = coordinator.acquire({ ...request, projectId: project.projectId, flowId: attemptId, attemptId, owner }))) {
        const holders = describeHolders(coordinator, resource);
        assert(Date.now() - started < resourceWaitMs, `doctor host resource wait exhausted after ${Math.round((Date.now() - started) / 1000)} s; ${resource} held by ${holders}`);
        if (holders !== reported) { reported = holders; try { onResourceWait?.({ resource, holders, since: new Date(started).toISOString() }); } catch {} progress('permit wait', `waiting up to ${Math.round(resourceWaitMs / 60000)} min for ${resource}, held by ${holders}`); }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // Acquired: clear any reported holder before verification runs.
      if (reported !== null) { try { onResourceWait?.(null); } catch {} }
      progress('main verification', `${resource} acquired; verifying ${config.repository.remote ?? 'origin'}/${config.repository.target}`);
      mainHealth = (await runMaintenanceAction({ projectRoot: project.root, cwd: project.root, action: { operation: 'main.verify', stateDir, projectId: project.projectId, flowId: attemptId, config } }, { run })).mainHealth;
    } finally { if (lease) coordinator.release(lease.resource, lease.token); coordinator.close(); }
    assert(mainHealth.status === 'green', 'main baseline verification failed');
  } catch (error) { reasons.push(error.message); }
  try {
    return store.tx(() => {
      if (store.meta('configDigest') !== checkedConfigDigest) reasons.push('configuration changed during commissioning; rerun doctor');
      if (modelSettingsVersion(store) !== checkedModelVersion) reasons.push('model defaults changed during commissioning; rerun doctor');
      const record = { ready: reasons.length === 0, configDigest: checkedConfigDigest, checkedAt, ...(codexSandbox ? { codexSandbox } : {}), ...(attemptEnvironment ? { attemptEnvironment: redactSecretValues(attemptEnvironment, secrets) } : {}), ...redactSecretValues({ providers, reasons, warnings, gh: { path: gh.path ?? null, realPath: gh.realPath ?? null, pinned: gh.pinned ?? false } }, secrets) };
      store.setMeta('commissioning', record); if (mainHealth && store.meta('configDigest') === checkedConfigDigest) setTargetHealth(store, null, mainHealth);
      store.event('project.doctor', { ready: record.ready, reasons: record.reasons }); return record;
    });
  } finally { store.close(); }
}
// actor/onBehalfOf/authority: who imports, with the same authority rules as any task.put. The
// CLI passes them from --actor, --instruction, --reference and --authority; source
// synchronization imports as the operator's configured sync.
export async function importGitHubTask(stateDir, issue, { transport,expectedConfigDigest,allowTrackedImportState=false,actor='operator',onBehalfOf,authority } = {}) {
  const store = new Store(stateDir);
  try {
    const config = store.meta('config'), configDigest = store.meta('configDigest'), project = store.meta('project');
    assert(expectedConfigDigest===undefined||expectedConfigDigest===configDigest,'source configuration changed during import');
    const forge = createGitHub({ repository: config.repository.slug, account: config.repository.account, hostname: config.repository.hostname, ghPath: config.repository.ghPath, issueProfile: config.repository.issueProfile, transport });
    const remote = await forge.readTask(issue);
    assert(remote.state === 'open' && remote.acceptance.length > 0, 'open issue with explicit acceptance criteria required');
    assert(store.meta('configDigest') === configDigest, 'configuration changed during issue import');
    assert(allowTrackedImportState||!remote.labels.some(label => (config.repository.issueProfile?.importBlockedLabels ?? []).includes(label)), 'issue is already in progress or held by its import state');
    assert(!remote.blocked, `issue is not admissible: ${(remote.blockedReasons ?? []).join('; ')}`);
    const prefix=config.repository.issueProfile?.dependencyIdPrefix??'github:',maxDependencies=config.repository.issueProfile?.maxDependencies??32;
    assert(remote.dependencies.length<=maxDependencies,'remote dependency limit exceeded');
    const taskId=`${prefix}${remote.number}`,prior=store.get('task',taskId),externalDependencies=[],dependencies=[];
    for(const dependency of remote.dependencies){
      const external=dependencyNumber(dependency,config.repository.issueProfile);
      if(external===null){dependencies.push(dependency);continue;}
      assert(Number.isSafeInteger(external)&&external>0&&external!==remote.number,'remote dependency cannot be invalid or self-referential');
      const dependencyId=`${prefix}${external}`;dependencies.push(dependencyId);
      if(externalDependencies.some(fact=>fact.issue===external))continue;
      let fact;try{fact=await forge.readDependency(external);}catch{fact={repository:remote.repository,issue:external,state:'unknown',revision:null,observedAt:now(),provenance:'github-issue-state',reason:'dependency-state-unavailable'};}
      const old=prior?.source?.externalDependencies?.find(item=>item.issue===external&&item.repository===fact.repository&&item.state===fact.state&&item.revision===fact.revision);
      externalDependencies.push({...fact,taskId:dependencyId,...(old?.observedAt?{observedAt:old.observedAt}:{})});
    }
    assert(!dependencies.includes(taskId),'task dependency cannot be self-referential');
    assert(store.meta('configDigest')===configDigest,'configuration changed during dependency discovery');
    // Issue labels become task labels, minus the ones that only control import eligibility.
    const controlLabels = new Set([...(config.sourceSync?.labels ?? config.repository.issueProfile?.requiredLabels ?? []), ...(config.repository.issueProfile?.importBlockedLabels ?? []), ...Object.values(config.repository.issueProfile?.lifecycle?.labels ?? {}), config.repository.issueProfile?.lifecycle?.approvalLabel].filter(Boolean));
    const labels = (remote.labels ?? []).filter(label => !controlLabels.has(label)).slice(0, 16).map(label => label.slice(0, 40));
    // The brief's outcome, when it says more than the issue title, is part of the brief agents are
    // given. A task imported before outcomes were kept gains it only when its issue changes, so
    // an unchanged issue keeps its approved revision.
    const outcome = typeof remote.outcome === 'string' && remote.outcome.trim() && remote.outcome.trim() !== remote.title.trim() && (!prior || prior.source?.revision !== remote.revision || prior.outcome !== undefined) ? remote.outcome.trim() : undefined;
    const task = { id: taskId, title: remote.title, ...(outcome ? { outcome } : {}), acceptance: remote.acceptance, labels, ...(remote.workflow ? { workflow: remote.workflow } : {}), ...(remote.inputs ? { inputs: remote.inputs } : {}), ...(remote.originalRequest !== undefined ? { originalRequest: remote.originalRequest } : {}), notBefore: remote.notBefore ?? null, source: { repository: remote.repository, issue: remote.number, revision: remote.revision,externalDependencies }, risk: remote.risk, dependencies:[...new Set(dependencies)], postMerge: remote.postMerge, paths: remote.paths, ...(remote.area ? {area:remote.area}:{}), ...(remote.category ? {category:remote.category}:{}), ...(remote.parent ? {parent:remote.parent}:{}), followup: remote.followup, blocked: remote.blocked, closed: false };
    const result = executeCommand(store, { protocolVersion: 1, projectId: project.projectId, commandId: `source-sync-${uid()}`, operation: 'task.put', actor, ...(onBehalfOf ? { onBehalfOf } : {}), ...(authority ? { authority } : {}), payload: { task,expectedRevision:prior?.revision??null } });
    assert(result.status === 'completed', result.error ?? 'task import rejected'); return result.result;
  } finally { store.close(); }
}
