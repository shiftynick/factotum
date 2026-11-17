import { turnLimitText } from '../../core/turn-limit.mjs';
import { randomUUID } from 'node:crypto';
import { usageObservation } from '../../operations/usage-accounting.mjs';
import { limitSignals, exhausted } from '../../operations/provider-limits.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, chmod, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const text = { type:'string' }, strings = { type:'array', items:text };
export const PLAN_SCHEMA = object({ status:{ enum:['ready','blocked'] }, summary:text, files:strings, checks:strings, risks:strings, questions:strings });
export const BUILD_SCHEMA = object({ status:{ enum:['implemented','blocked'] }, summary:text });
export const REVIEW_SCHEMA = object({ verdict:{ enum:['pass','revise'] }, summary:text, findings:{ type:'array', items:object({ severity:{ enum:['critical','high','medium','low'] }, file:text, line:{ type:'integer', minimum:0 }, message:text }) } });
export const RISK_SCHEMA = object({ level:{ enum:['ordinary','strict'] }, rationale:text, threatModel:strings, stopConditions:strings });
const reportText = {type:'string',minLength:1};
const reportStrings = {type:'array',items:reportText};
const workerReport = { departures:{type:'array',items:object({from:reportText,why:reportText})}, unverified:reportStrings, pushback:{type:'array',items:object({ruleId:reportText,ruleText:reportText,cost:reportText,proposal:reportText})} };
// Planner and builder questions (dev.83): questions stop the flow for an answer; assumptions are
// questions whose answer would not change the work, each with the answer assumed. They do not stop it.
const assumptions = {type:'array',items:object({question:reportText,assumption:reportText})};
// Citations of the advisory learnings a step was given (knowledge-upkeep design 11.3): a learning's id
// (learning- and 12 hexadecimal digits) and how it was used. Ids and enumerations only, so a citation
// carries no text of its own into a later prompt; an id not in the flow's selection is ignored.
const learningId = {type:'string',minLength:1,maxLength:21};
const learningsApplied = {type:'array',items:object({id:learningId,use:{enum:['applied','contradicted']}})};
const learningsChecked = {type:'array',items:object({id:learningId,outcome:{enum:['followed','contradicted']}})};
export const DELIVERY_BUILD_SCHEMA = object({ ...BUILD_SCHEMA.properties, ...workerReport, questions:reportStrings, assumptions, learningsApplied });
export const RISK_PLAN_SCHEMA = object({ ...PLAN_SCHEMA.properties, ...workerReport, questions:reportStrings, assumptions, riskAssessment:RISK_SCHEMA, learningsApplied });
export const RISK_REVIEW_SCHEMA = object({ ...REVIEW_SCHEMA.properties, riskAssessment:RISK_SCHEMA });
export const CHANGE_REVIEW_SCHEMA = object({ ...RISK_REVIEW_SCHEMA.properties, strictReview:object({ fullDiffInspected:{type:'boolean'}, threatModelReviewed:{type:'boolean'}, stopConditionsReviewed:{type:'boolean'} }), scopeSummary:reportText, priorFindingsDisposition:{type:'array',items:object({finding:reportText,disposition:{enum:['fixed','remaining','outside-scope']},evidence:reportText})}, learningsChecked });
// The upkeep role (knowledge upkeep's assessment) always passes its own schema; it is read-only like a reviewer.
const schemas = { planner:PLAN_SCHEMA, builder:BUILD_SCHEMA, reviewer:REVIEW_SCHEMA, auditor:REVIEW_SCHEMA, reader:REVIEW_SCHEMA, scoreboardOwner:REVIEW_SCHEMA, upkeep:REVIEW_SCHEMA };
const family = provider => provider === 'codex' ? 'openai' : 'anthropic';
const envKeys = ['HOME','PATH','USER','LOGNAME','SHELL','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR'];
export function subscriptionEnvironment(source=process.env) {
  return { ...Object.fromEntries(envKeys.filter(k => source[k]).map(k => [k,source[k]])), NO_COLOR:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1' };
}
export class ProviderError extends Error {
  constructor(message, { started=false, code='PROVIDER_REJECTED' }={}) { super(message); this.name='ProviderError'; this.started=started; this.code=code; this.safeToRetry=!started; }
}

// Deliberately bounded subset: reject unsupported schema keywords instead of silently ignoring them.
export function validateSchema(value, schema, path='$') {
  const supported = new Set(['type','properties','required','additionalProperties','items','enum','minimum','maximum','minItems','maxItems','minLength','maxLength','description','title']);
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new ProviderError(`Unsupported schema keyword ${key}`,{code:'SCHEMA_UNSUPPORTED'});
  if (schema.enum && !schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value))) throw new Error(`${path}: invalid enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const match = type => type==='null' ? value===null : type==='array' ? Array.isArray(value) : type==='object' ? value!==null && typeof value==='object' && !Array.isArray(value) : type==='integer' ? Number.isSafeInteger(value) : type==='number' ? typeof value==='number' && Number.isFinite(value) : typeof value===type;
    if (!types.some(match)) throw new Error(`${path}: expected ${types.join('|')}`);
  }
  if (value && typeof value==='object' && !Array.isArray(value)) {
    for (const key of schema.required||[]) if (!Object.hasOwn(value,key)) throw new Error(`${path}.${key}: required`);
    for (const [key,item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(item,schema.properties[key],`${path}.${key}`);
      else if (schema.additionalProperties===false) throw new Error(`${path}.${key}: unexpected`);
      else if (typeof schema.additionalProperties==='object') validateSchema(item,schema.additionalProperties,`${path}.${key}`);
    }
  }
  if (Array.isArray(value)) { if (schema.minItems!==undefined && value.length<schema.minItems || schema.maxItems!==undefined && value.length>schema.maxItems) throw new Error(`${path}: invalid array length`); if (schema.items) value.forEach((v,i)=>validateSchema(v,schema.items,`${path}[${i}]`)); }
  if (typeof value==='number' && (schema.minimum!==undefined && value<schema.minimum || schema.maximum!==undefined && value>schema.maximum)) throw new Error(`${path}: outside bounds`);
  if (typeof value==='string' && (schema.minLength!==undefined && value.length<schema.minLength || schema.maxLength!==undefined && value.length>schema.maxLength)) throw new Error(`${path}: invalid length`);
  return value;
}

export function validateSchemaDefinition(schema) {
  const supported = new Set(['type','properties','required','additionalProperties','items','enum','minimum','maximum','minItems','maxItems','minLength','maxLength','description','title']);
  if (!schema || typeof schema!=='object' || Array.isArray(schema)) throw new ProviderError('Schema must be an object',{code:'SCHEMA_UNSUPPORTED'});
  for(const key of Object.keys(schema)) if(!supported.has(key)) throw new ProviderError(`Unsupported schema keyword ${key}`,{code:'SCHEMA_UNSUPPORTED'});
  if(schema.type && !(Array.isArray(schema.type)?schema.type:[schema.type]).every(t=>['null','object','array','integer','number','string','boolean'].includes(t))) throw new ProviderError('Unsupported schema type',{code:'SCHEMA_UNSUPPORTED'});
  for(const child of Object.values(schema.properties||{})) validateSchemaDefinition(child);
  if(schema.items)validateSchemaDefinition(schema.items);
  if(schema.additionalProperties && typeof schema.additionalProperties==='object')validateSchemaDefinition(schema.additionalProperties);
  return schema;
}

// What a process that runProcess stopped did, in words: the error message names the process by
// `label` (by default the executable's name), never as a provider unless the caller says it is one.
const seconds = ms => `${Math.round(ms / 1000)} s`;
const ENDED = { TIMEOUT: ({ timeoutMs }) => `timed out after ${seconds(timeoutMs)}`, CANCELLED: () => 'was cancelled', OUTPUT_LIMIT: ({ maxBytes }) => `was stopped for writing more than ${maxBytes} bytes of output`, DESCENDANTS_SURVIVE: () => 'left processes running after it exited' };
// New process group belongs to this invocation, never the caller. Kill descendants even if the CLI exits first.
// A stopped process rejects with a ProviderError whose code is the reason (TIMEOUT, CANCELLED,
// OUTPUT_LIMIT, DESCENDANTS_SURVIVE) and which carries elapsedMs and timeoutMs, and its partial
// stdout and stderr as non-enumerable properties.
export function runProcess(binary,args,{cwd,env,input='',signal,timeoutMs=30_000,maxBytes=16*1024*1024,label=basename(String(binary))}={}) {
  return new Promise((resolvePromise,reject)=>{
    if (signal?.aborted) return reject(new ProviderError(`${label} was cancelled before launch`,{code:'CANCELLED'}));
    const startedAt=Date.now();
    const child=spawn(binary,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',spawned=false,reason=null,killTimer;
    const kill = sig => { try { process.kill(-child.pid,sig); } catch {} };
    const stop = why => { if(reason) return; reason=why;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000); };
    const abort=()=>stop('CANCELLED'); signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('TIMEOUT'),timeoutMs);
    child.on('spawn',()=>{spawned=true;}); child.stdin.on('error',()=>{}); child.stdin.end(input);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',b=>{if(reason)return;stdout+=b; if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxBytes) stop('OUTPUT_LIMIT');});
    child.stderr.on('data',b=>{if(reason)return;stderr+=b; if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>maxBytes) stop('OUTPUT_LIMIT');});
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',error=>{cleanup();clearTimeout(killTimer);reject(new ProviderError(`${label} could not start${error.code ? ` (${error.code})` : ''}`,{code:error.code??'SPAWN_FAILED'}));});
    child.on('close',code=>{cleanup(); if(!reason && spawned) { try { process.kill(-child.pid,0); reason='DESCENDANTS_SURVIVE'; kill('SIGKILL'); } catch {} } if(reason) { kill('SIGKILL'); clearTimeout(killTimer); const error=new ProviderError(`${label} ${ENDED[reason]({timeoutMs,maxBytes})}`,{started:spawned,code:reason});Object.assign(error,{elapsedMs:Date.now()-startedAt,timeoutMs});Object.defineProperties(error,{stdout:{value:stdout},stderr:{value:stderr}});reject(error); } else { clearTimeout(killTimer); resolvePromise({stdout,stderr,code,started:spawned}); } });
  });
}

function checkSpec(spec) {
  if (!['codex','claude'].includes(spec.provider) || !schemas[spec.role]) throw new ProviderError('Unsupported provider or role');
  if (typeof spec.model!=='string' || !spec.model.trim() || spec.model.startsWith('-') || !/^[a-zA-Z0-9._:/-]+$/.test(spec.model)) throw new ProviderError('Explicit model identifier required');
  if (spec.allowedModels !== undefined && (!Array.isArray(spec.allowedModels) || !spec.allowedModels.every(m=>typeof m==='string') || !spec.allowedModels.includes(spec.model))) throw new ProviderError('Model is outside the configured allowlist',{code:'MODEL_NOT_ALLOWED'});
  if (spec.billingMode !== undefined && spec.billingMode !== 'subscription') throw new ProviderError('Only subscription billing is supported',{code:'BILLING_UNVERIFIED'});
  if (spec.effort !== undefined && !(spec.provider==='codex'?['minimal','low','medium','high','xhigh']:['low','medium','high','xhigh','max']).includes(spec.effort)) throw new ProviderError('Unsupported reasoning effort');
  if (!spec.cwd || !spec.artifactDir || typeof spec.prompt!=='string' || !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs<1) throw new ProviderError('cwd, artifactDir, prompt and positive timeoutMs required');
  if (spec.role!=='builder' && spec.sessionId) throw new ProviderError('Independent planner/reviewer must use a fresh session');
  if (spec.maxTurns!==undefined && (!Number.isSafeInteger(spec.maxTurns)||spec.maxTurns<1)) throw new ProviderError('maxTurns must be a positive integer');
  validateSchemaDefinition(spec.schema||schemas[spec.role]);
  if (spec.sessionId && !/^[0-9a-f-]{36}$/i.test(spec.sessionId)) throw new ProviderError('Invalid session ID');
  if (spec.role!=='builder' && spec.readOnly===false) throw new ProviderError('Planner/reviewer require read-only permissions');
  if (spec.suppressWorktreeInstructions!==undefined && typeof spec.suppressWorktreeInstructions!=='boolean') throw new ProviderError('suppressWorktreeInstructions must be boolean');
  if (spec.heldProviders!==undefined && (!Array.isArray(spec.heldProviders) || !spec.heldProviders.every(p=>typeof p==='string'))) throw new ProviderError('heldProviders must list provider names');
}
// Limit reports never decide success; a parse problem only loses the report.
const safeSignals = (provider, stdout) => { try { return limitSignals(provider, stdout); } catch { return []; } };
const withPlan = (signals, qualification) => qualification?.plan ? signals.map(s => s.plan ? s : { ...s, plan: qualification.plan }) : signals;
const usageLimitError = (provider, detail) => new ProviderError(`${provider} usage limit reached after the model process started${detail ? ` (${detail})` : ''}; effects are uncertain and the attempt needs reconciliation, never an automatic retry`,{started:true,code:'USAGE_LIMIT'});
// How a Claude run ended when it did not succeed: the final result's subtype (error_max_turns,
// error_during_execution, ...), turn count, reported cost and session, or null when there is no
// unique final result. Codex has no turn limit in this adapter (exec takes no turn cap; a Codex
// step is bounded by its timeout) and reports a failed turn as turn.failed or error, which stays
// INVALID_RESULT.
function finalEnding(spec, stdout) {
  if (spec.provider !== 'claude') return null;
  let finals; try { finals = String(stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e?.type === 'result'); } catch { return null; }
  if (finals.length !== 1) return null;
  const final = finals[0];
  return { provider: spec.provider, model: spec.model, subtype: typeof final.subtype === 'string' ? final.subtype.slice(0, 80) : null,
    turns: Number.isSafeInteger(final.num_turns) ? final.num_turns : null, costUsd: Number.isFinite(final.total_cost_usd) && final.total_cost_usd >= 0 ? final.total_cost_usd : null,
    sessionId: typeof final.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(final.session_id) ? final.session_id : null };
}
export { turnLimitText };
const codexConfig=['--ignore-user-config','--ignore-rules','-c','model_provider="openai"','-c','forced_login_method="chatgpt"','-c','approval_policy="never"'];
const claudeConfig=['--safe-mode','--setting-sources','','--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];
// Worktree isolation (docs/changes/provider-worktree-isolation.md). Every model step, fresh and
// resumed, for every task: the provider loads no configuration, skills, hooks or instructions from
// its worktree, whatever a builder, a check or an earlier change put there, and no skill of the
// operator's own. The factory delivers the governing context itself (operations/context.mjs).
// - Codex runs from a fresh, empty working root the factory creates outside the worktree (in the
//   step's private artifact folder), with the worktree as its writable root
//   (sandbox_workspace_write.writable_roots) and the prompt naming it. Codex discovers repository
//   skills, AGENTS.md files and the project .codex/ layer only from its working directory (and,
//   without project root markers, not from any folder above it), so nothing in the worktree is
//   discovered at all, whenever it was written; a $name or linked mention resolves only to a
//   discovered skill. With --ignore-user-config and --ignore-rules (above):
//   --disable hooks                     features.hooks off: no hook from any layer;
//   --skip-git-repo-check               the working root is not a Git repository;
//   -c project_doc_max_bytes=0          no AGENTS.override.md, AGENTS.md or fallback project document;
//   -c skills.include_instructions=false  no skills catalog in the model's context;
//   -c skills.bundled.enabled=false     no skill bundled with Codex;
//   -c project_root_markers=[]          no search above the working root;
//   -c sandbox_workspace_write.writable_roots=[<worktree>]  where the model works;
//   -c projects={<dir>={trust_level="untrusted"}, ...}  the working root, the worktree and every
//                                       folder above them explicitly untrusted;
//   -c skills.config=[{path=<SKILL.md>,enabled=false}, ...]  each of the operator's own skills
//                                       ($CODEX_HOME/skills, $HOME/.agents/skills, /etc/codex/skills),
//                                       found at invocation. These folders are the operator's, not the
//                                       candidate's: a candidate reaches them only by a process writing
//                                       outside its worktree, which no provider option can prevent.
// - Claude Code: --safe-mode (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and
//   agents disabled, the operator's own included), --setting-sources '' (no user, project or local
//   settings) and --disable-slash-commands (no skills or commands at all), with --restricted and an
//   empty --strict-mcp-config below.
// The adapter fails closed: an invocation whose arguments or working root lack these is refused
// before the CLI starts.
export const WORKTREE_ISOLATION = Object.freeze({
  codex: Object.freeze(['--disable','hooks','--skip-git-repo-check','-c','project_doc_max_bytes=0','-c','skills.include_instructions=false','-c','skills.bundled.enabled=false','-c','project_root_markers=[]']),
  claude: Object.freeze(['--safe-mode','--setting-sources','','--disable-slash-commands']),
});
// The governance-edit change's name for the same flags (a step of a task approved to change
// governing files requires them; every step now has them).
export const WORKTREE_INSTRUCTION_SUPPRESSION = WORKTREE_ISOLATION;
// The operator's own Codex skill folders, relative to the environment's CODEX_HOME (default
// $HOME/.codex) and HOME, and the administrator's.
export const OPERATOR_SKILL_FOLDERS = Object.freeze([['CODEX_HOME', 'skills'], ['HOME', '.agents/skills'], [null, '/etc/codex/skills']]);
// Bounds on that scan: folder depth, folders read, entries in one folder, and distinct skills (by real path).
export const CODEX_SKILL_SCAN_LIMITS = Object.freeze({ depth: 8, directories: 2000, entries: 4096, skills: 256 });
const isolationRefused = message => new ProviderError(`${message}; the provider is not started, since it could load instructions the factory did not deliver`,{code:'PROVIDER_REJECTED'});
// A TOML basic string. Paths with control characters or unpaired surrogates are refused, never escaped.
function tomlString(text) {
  if (typeof text !== 'string' || /[\x00-\x1f\x7f]/.test(text) || !text.isWellFormed()) throw isolationRefused(`the path ${JSON.stringify(String(text))} cannot be passed to Codex as configuration`);
  return `"${text.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
}
const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
// Every SKILL.md (any letter case) under a skill folder, following links as Codex does. Bounded:
// a folder that cannot be read, or a tree past the bounds, refuses the invocation.
async function skillFiles(root, found, budget, depth=0) {
  let dir;
  try { dir = await opendir(root); }
  catch (error) { if (depth === 0 && ['ENOENT','ENOTDIR'].includes(error?.code)) return; throw isolationRefused(`the skill folder ${root} cannot be listed (${error?.code ?? 'error'})`); }
  if (++budget.directories > CODEX_SKILL_SCAN_LIMITS.directories) { await dir.close().catch(() => {}); throw isolationRefused(`more than ${CODEX_SKILL_SCAN_LIMITS.directories} folders under the operator's skill folders`); }
  const entries = [];
  try { for await (const entry of dir) { if (entries.length >= CODEX_SKILL_SCAN_LIMITS.entries) throw isolationRefused(`more than ${CODEX_SKILL_SCAN_LIMITS.entries} entries in the skill folder ${root}`); entries.push(entry); } }
  catch (error) { await dir.close().catch(() => {}); if (error instanceof ProviderError) throw error; throw isolationRefused(`the skill folder ${root} cannot be listed (${error?.code ?? 'error'})`); }
  for (const entry of entries) {
    const path = join(root, entry.name);
    let kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
    if (entry.isSymbolicLink()) { try { const target = await stat(path); kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : null; } catch { kind = null; } }
    if (kind !== 'file' && kind !== 'directory') continue;
    let real; try { real = await realpath(path); } catch (error) { throw isolationRefused(`${path} cannot be resolved (${error?.code ?? 'error'})`); }
    if (kind === 'file') {
      if (entry.name.toLowerCase() !== 'skill.md') continue;
      // Both spellings are disabled; only distinct files count against the bound.
      found.paths.add(path); found.paths.add(real); found.real.add(real);
      if (found.real.size > CODEX_SKILL_SCAN_LIMITS.skills) throw isolationRefused(`more than ${CODEX_SKILL_SCAN_LIMITS.skills} skills in the operator's skill folders`);
    } else {
      if (budget.seen.has(real)) continue; budget.seen.add(real);
      if (depth + 1 > CODEX_SKILL_SCAN_LIMITS.depth) throw isolationRefused(`a skill folder deeper than ${CODEX_SKILL_SCAN_LIMITS.depth} levels under ${root}`);
      await skillFiles(path, found, budget, depth + 1);
    }
  }
}
const ancestorsOf = path => { const out = []; for (let dir = path; ; dir = dirname(dir)) { out.push(dir); if (dirname(dir) === dir) break; } return out; };
// The per-invocation part of Codex's isolation: a fresh empty working root in the step's artifact
// folder, outside the worktree, and the arguments that depend on it, the worktree and the
// operator's skill folders.
export async function codexWorktreeIsolation({ cwd, artifactDir, environment = {} }) {
  let worktree; try { worktree = await realpath(cwd); } catch (error) { throw isolationRefused(`the working directory ${cwd} cannot be resolved (${error?.code ?? 'error'})`); }
  const root = await realpath(await mkdtemp(join(resolve(artifactDir), 'codex-root-')));
  await chmod(root, 0o700);
  if (within(root, worktree) || within(worktree, root)) throw isolationRefused(`the step's artifact folder ${artifactDir} is inside the worktree ${worktree} (or holds it), so Codex cannot be given a working root the worktree does not contain`);
  const home = environment.HOME, codexHome = environment.CODEX_HOME || (home ? join(home, '.codex') : null);
  const bases = { CODEX_HOME: codexHome, HOME: home };
  const found = { paths: new Set(), real: new Set() }, budget = { directories: 0, seen: new Set() };
  for (const [base, folder] of OPERATOR_SKILL_FOLDERS) { const from = base ? bases[base] : ''; if (base && !from) continue; await skillFiles(base ? join(from, folder) : folder, found, budget); }
  const untrusted = [...new Set([...ancestorsOf(root), ...ancestorsOf(worktree)])];
  return { root, worktree, args: [
    '-c', `sandbox_workspace_write.writable_roots=[${tomlString(worktree)}]`,
    '-c', `projects={${untrusted.map(dir => `${tomlString(dir)}={trust_level="untrusted"}`).join(',')}}`,
    '-c', `skills.config=[${[...found.paths].sort().map(path => `{path=${tomlString(path)},enabled=false}`).join(',')}]`,
  ] };
}
// What the model is told about where it works, ahead of the factory's prompt (Codex only).
// A builder is also told what Codex's sandbox may refuse (dev.91, O2): on some Linux hosts its
// workspace-write sandbox denies shutdown(2) and getsockopt(2) even on a local socket pair, so Node's
// spawnSync and execSync with a piped stdin fail with EPERM, and the project's own tests that start
// processes that way fail there. The factory's checks run outside the sandbox and decide.
export const CODEX_SANDBOX_NOTICE = 'Commands you run go through Codex\'s sandbox, which on some hosts refuses parts of process and socket handling that the project\'s own checks need (for example Node\'s spawnSync and execSync fail with EPERM there) and has no network. The factory runs the project\'s checks itself, outside the sandbox, after you return, and their results decide. A command that fails only for such a sandbox reason is not a reason to return blocked: finish the work, return implemented, and name the command and the sandbox error in your summary.';
export const codexWorktreeNotice = (worktree, { builder = false } = {}) => `Repository: ${worktree}\nThis is the repository for this step. It is not your current directory: run every command with ${worktree} as its working directory, and read and write files by their paths under it.${builder ? `\n${CODEX_SANDBOX_NOTICE}` : ''}\n\n`;
// Whether Node can start a child process with a piped stdin inside Codex's workspace-write sandbox on
// this host, checked offline with `codex sandbox` (no model, no account). The factory's own Codex
// settings are repeated: no network. Returns {spawn: 'ok' | 'refused' | 'unknown', error?, detail?}.
// The result is written with fs.writeSync: the probe's stdout is a socket (Node spawns its children's
// stdio that way), and the sandbox refuses the shutdown that process.stdout.write needs to flush it,
// so an asynchronous write is lost and the probe reads as unknown (adopter report on dev.91).
export const CODEX_SANDBOX_SPAWN_PROBE = "const r=require('node:child_process').spawnSync(process.execPath,['-e','0'],{encoding:'utf8'});require('node:fs').writeSync(1,JSON.stringify({status:r.status,error:r.error?(r.error.code||r.error.message):null}))";
export async function codexSandboxSpawnProbe({ run = runProcess, cwd, environment = process.env, timeoutMs = 20_000 } = {}) {
  let result;
  try { result = await run('codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false', '--', process.execPath, '-e', CODEX_SANDBOX_SPAWN_PROBE], { cwd, env: subscriptionEnvironment(environment), timeoutMs, label: 'codex sandbox probe' }); }
  catch (error) { return { spawn: 'unknown', detail: String(error?.message ?? error).slice(0, 300) }; }
  let parsed = null; try { parsed = JSON.parse(String(result?.stdout ?? '').trim().split('\n').at(-1)); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return { spawn: 'unknown', detail: `codex sandbox exited ${result?.code ?? 'without a code'}: ${String(result?.stderr ?? result?.stdout ?? '').trim().slice(0, 300)}` };
  return parsed.error ? { spawn: 'refused', error: String(parsed.error).slice(0, 100) } : { spawn: 'ok' };
}
const contains = (args, flags) => args.some((arg, i) => flags.every((flag, j) => args[i + j] === flag));
// Fail closed: every invocation carries its provider's isolation (Codex: the static flags, then the
// writable root, the untrusted projects and the disabled skills, from a working root outside the
// worktree).
export function assertWorktreeIsolation(provider, args, { workingRoot, worktree } = {}) {
  const flags = WORKTREE_ISOLATION[provider];
  const codexShape = () => args.some((arg, i) => arg === '-c' && args[i + 1]?.startsWith('sandbox_workspace_write.writable_roots=[') && args[i + 2] === '-c' && args[i + 3]?.startsWith('projects={') && args[i + 4] === '-c' && args[i + 5]?.startsWith('skills.config=['))
    && typeof workingRoot === 'string' && typeof worktree === 'string' && !within(workingRoot, worktree) && !within(worktree, workingRoot);
  const ok = flags && contains(args, flags) && (provider !== 'codex' || codexShape());
  if (!ok) throw new ProviderError(`${provider} cannot be started without loading configuration, skills, hooks or instructions from the working directory; no model step uses it`,{code:'PROVIDER_REJECTED'});
}
// A provider preflight makes PREFLIGHT_CALLS CLI calls (--version, --help, auth status), each
// bounded by PREFLIGHT_CALL_TIMEOUT_MS (doctor's time bound is built from these).
export const PREFLIGHT_CALL_TIMEOUT_MS = 15_000, PREFLIGHT_CALLS = 3;
// Whether --help lists an option as a whole word: --disable is not listed by --disable-slash-commands.
export const helpLists = (text, flag) => new RegExp(`(^|[\\s,\\[(])${flag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[\\s,=<\\])])`).test(String(text ?? ''));
const MISSING_CLI = new Set(['ENOENT','EACCES','ENOTDIR','SPAWN_FAILED']);
export function createProviderAdapter({ transport=runProcess, environment=process.env }={}) {
  const env=subscriptionEnvironment(environment);
  async function preflight(spec) {
    checkSpec(spec);
    // Each CLI call is bounded by PREFLIGHT_CALL_TIMEOUT_MS. A failure says which call failed and how
    // (`failure`: timeout, missing-cli, process-error, invalid-result, auth), keeps the process's own
    // code (`processCode`, for example TIMEOUT or ENOENT) and, as the non-enumerable `stderr`, what
    // the CLI wrote to stderr, so doctor can report it (redacted and bounded there). The auth call's
    // output is never kept, on any path: it can name the account, its home directory or its
    // organization, which known-secret redaction does not remove. Its failure keeps only the kind
    // and the exit status (or process code).
    const run=async(call,args)=>{ try { return await transport(spec.provider,args,{cwd:spec.cwd,env,timeoutMs:PREFLIGHT_CALL_TIMEOUT_MS,label:`${spec.provider} ${call}`}); }
      catch(error) { const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)?error.code:null, failure=code==='TIMEOUT'?'timeout':MISSING_CLI.has(code)?'missing-cli':'process-error';
        const failed=new ProviderError(`${spec.provider} CLI preflight failed before model launch: ${failure==='timeout'?`${spec.provider} ${call} timed out after ${Math.round(PREFLIGHT_CALL_TIMEOUT_MS/1000)} s`:failure==='missing-cli'?`the ${spec.provider} CLI could not be started (${code})`:`${spec.provider} ${call} failed${code?` (${code})`:''}`}`,{code:'PREFLIGHT_FAILED'});
        Object.defineProperty(failed,'stderr',{value:call!=='auth status'&&typeof error?.stderr==='string'?error.stderr:''}); throw Object.assign(failed,{call,failure,...(code?{processCode:code}:{})}); } };
    const rejected=(message,call,result,options)=>{ const error=new ProviderError(message,options); Object.defineProperty(error,'stderr',{value:call==='auth status'?'':String(result?.stderr??'')}); return Object.assign(error,{call,failure:options?.code==='BILLING_UNVERIFIED'?'auth':'invalid-result'}); };
    const version=await run('--version',['--version']); if(version.code!==0) throw rejected(`${spec.provider} CLI version check failed (exit code ${version.code})`,'--version',version);
    const help=await run('--help',spec.provider==='codex' ? ['exec',...(spec.sessionId?['resume']:[]),'--help'] : ['--help']);
    const required=spec.provider==='codex'?['--ignore-user-config','--ignore-rules','--disable','--skip-git-repo-check','--output-schema','--json','--model','--config']:['--safe-mode','--setting-sources','--disable-slash-commands','--strict-mcp-config','--mcp-config','--json-schema','--tools','--restricted','--permission-mode','--permission-prompts'];
    if (spec.provider === 'claude' && spec.effort) required.push('--effort');
    if(help.code!==0 || required.some(flag=>!helpLists(help.stdout,flag))) throw rejected(`Installed ${spec.provider} CLI lacks required isolation/structured-output capabilities${help.code!==0?` (--help exit code ${help.code})`:`: missing ${required.filter(flag=>!helpLists(help.stdout,flag)).join(' ')}`}`,'--help',help);
    const auth=await run('auth status',spec.provider==='codex'?['login','status']:['--safe-mode','--setting-sources','','auth','status','--json']);
    let subscription=false;
    if(spec.provider==='codex') subscription=auth.code===0 && /Logged in using ChatGPT/i.test(auth.stdout+auth.stderr) && !/API key/i.test(auth.stdout+auth.stderr);
    else { try { const a=JSON.parse(auth.stdout);subscription=auth.code===0 && a.loggedIn===true && a.authMethod==='claude.ai' && a.apiProvider==='firstParty' && ['pro','max','team','enterprise'].includes(a.subscriptionType); } catch {} }
    // The auth output is not kept: it can name the account.
    if(!subscription) throw rejected(`${spec.provider} subscription billing route could not be verified (auth status exit code ${auth.code})`,'auth status',null,{code:'BILLING_UNVERIFIED'});
    let plan=null; if(spec.provider==='claude') { try { plan=JSON.parse(auth.stdout).subscriptionType ?? null; } catch {} }
    return {provider:spec.provider,version:version.stdout.trim(),...(plan?{plan}:{}),billing:{mode:'subscription'},capabilities:{resume:true,structuredOutput:true,readOnly:true}};
  }
  async function invokeOnce(spec,{signal}={}) {
    // A provider whose usage limit holds new work is refused before anything starts, so a
    // configured fallback may run (only positively unstarted failures may fall back).
    if (spec.heldProviders?.includes(spec.provider)) throw new ProviderError(`${spec.provider} usage limit hold: not started`,{code:'USAGE_LIMIT_HOLD'});
    const qualification = await preflight(spec); if(signal?.aborted) throw new ProviderError('Provider cancelled before launch',{code:'CANCELLED'});
    const artifactDir=resolve(spec.artifactDir);await mkdir(artifactDir,{recursive:true,mode:0o700});await chmod(artifactDir,0o700);
    const schema=spec.schema||schemas[spec.role], schemaFile=resolve(artifactDir,'output-schema.json');
    await writeFile(schemaFile,JSON.stringify(schema),{mode:0o600});
    const readOnly=spec.role!=='builder'||spec.readOnly===true;
    let args;
    const isolation = spec.provider==='codex' ? await codexWorktreeIsolation({ cwd: spec.cwd, artifactDir, environment: env }) : null;
    if(spec.provider==='codex') args=['exec',...(spec.sessionId?['resume']:[]),...codexConfig,...WORKTREE_ISOLATION.codex,...isolation.args,...(spec.effort?['-c',`model_reasoning_effort=${JSON.stringify(spec.effort)}`]:[]),'-c',`sandbox_mode="${readOnly?'read-only':'workspace-write'}"`,'--json','--model',spec.model,'--output-schema',schemaFile,...(spec.sessionId?[spec.sessionId]:[]),'-'];
    else args=[...claudeConfig,'--restricted','--print','--verbose','--output-format','stream-json','--model',spec.model,...(spec.effort?['--effort',spec.effort]:[]),'--json-schema',JSON.stringify(schema),'--permission-mode',readOnly?'plan':'acceptEdits','--permission-prompts','none','--tools',readOnly?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write,Bash','--allowedTools',readOnly?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write,Bash',...(spec.sessionId?['--resume',spec.sessionId]:[]),...(spec.maxTurns?['--max-turns',String(spec.maxTurns)]:[])];
    // Fail closed: no model step, of any task, runs without its provider's worktree isolation.
    assertWorktreeIsolation(spec.provider,args,isolation?{workingRoot:isolation.root,worktree:isolation.worktree}:{});
    const workingRoot = isolation?.root ?? spec.cwd, input = isolation ? codexWorktreeNotice(isolation.worktree, { builder: !readOnly }) + spec.prompt : spec.prompt;
    let run;
    const observationId = randomUUID(), startedAt = new Date().toISOString();
    try { run=await transport(spec.provider,args,{cwd:workingRoot,env,input,signal,timeoutMs:spec.timeoutMs,label:`${spec.provider} provider`}); }
    catch(error) {
      // A limit reported before the process ended (for example a timeout while the CLI waited on it) classifies the failure.
      const limits = withPlan(safeSignals(spec.provider, error?.stdout), qualification);
      let failure = error instanceof ProviderError ? error : new ProviderError('Provider transport failed',{started:true,code:'UNCERTAIN'});
      if (failure.started && exhausted(limits)) failure = usageLimitError(spec.provider, failure.message);
      failure.accountingResult = { provider: spec.provider, model: spec.model, sessionId: spec.sessionId ?? null, ...(limits.length ? { limits } : {}) };
      // Partial traces are best effort: a capture failure must never replace the started/uncertain classification.
      for (const [name, text] of [['stdout.jsonl', error?.stdout], ['stderr.txt', error?.stderr]]) if (typeof text === 'string') { try { await writeFile(resolve(artifactDir,name),text,{mode:0o600}); } catch {} }
      throw failure;
    }
    // Private traces can contain source text. They belong only in the operator-owned artifact directory.
    await writeFile(resolve(artifactDir,'stdout.jsonl'),run.stdout,{mode:0o600});await writeFile(resolve(artifactDir,'stderr.txt'),run.stderr,{mode:0o600});
    let accountingResult;
    const limits = withPlan(safeSignals(spec.provider, run.stdout), qualification);
    try {
      // Capture usage independently of structured task success. Never accept ambiguous finals.
      const events = run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const finals = events.filter(e => e.type === (spec.provider === 'codex' ? 'turn.completed' : 'result'));
      const sessionId = spec.provider === 'codex' ? events.find(e => e.type === 'thread.started')?.thread_id ?? spec.sessionId : finals[0]?.session_id;
      if (finals.length === 1 && !(spec.provider === 'codex' && events.some(e => e.type === 'turn.failed' || e.type === 'error')) && sessionId && (!spec.sessionId || sessionId === spec.sessionId)) {
        const event = finals[0];
        accountingResult = { provider: spec.provider, model: spec.model, sessionId, usage: event.usage,
          usageObservation: usageObservation({ provider: spec.provider, version: qualification.version, sessionId, resumedFrom: spec.sessionId,
            previousObservationId: spec.previousObservationId, id: observationId, startedAt, endedAt: new Date().toISOString(), event }),
          billing: { mode: 'subscription', actualMicros: null, accountCreditCost: 'unavailable' } };
      }
    } catch { /* Raw artifacts remain available; missing observation is not zero usage. */ }
    try {
      if(run.code!==0) throw new Error('CLI exited unsuccessfully');
      const events=run.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      let sessionId,result,usage,reportedCostUsd;
      if(spec.provider==='codex') {
        sessionId=events.find(e=>e.type==='thread.started')?.thread_id || spec.sessionId;
        const turns=events.filter(e=>e.type==='turn.completed');
        if(turns.length!==1 || events.some(e=>e.type==='turn.failed'||e.type==='error')) throw new Error('No unique completed turn');
        usage=turns[0].usage;
        const messages=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');result=JSON.parse(messages.at(-1)?.item.text||'');
      } else {
        const finals=events.filter(e=>e.type==='result');if(finals.length!==1 || finals[0].is_error || finals[0].subtype!=='success') throw new Error('No unique successful result');
        const final=finals[0];sessionId=final.session_id;result=final.structured_output;usage=final.usage;if(Number.isFinite(final.total_cost_usd)&&final.total_cost_usd>=0)reportedCostUsd=final.total_cost_usd;
        if(!result) throw new Error('Structured result missing');
      }
      if(typeof sessionId!=='string'||!sessionId || !usage || typeof usage!=='object' || Array.isArray(usage)) throw new Error('Session or usage receipt missing');
      if(spec.sessionId && sessionId!==spec.sessionId) throw new Error('Provider resumed a different session');
      validateSchema(result,schema);
      const normalized={...accountingResult,...(limits.length?{limits}:{}),provider:spec.provider,model:spec.model,...(spec.effort?{effort:spec.effort}:{}),family:family(spec.provider),sessionId,result,usage,...(reportedCostUsd!==undefined?{reportedCostUsd}:{}),permissions:{requested:readOnly?'read-only':'workspace-write',enforced:spec.provider==='codex'?'provider-sandbox':readOnly?'provider-tool-allowlist':'provider-restricted-tools'},billing:{mode:'subscription',actualMicros:null,accountCreditCost:'unavailable'},started:true,final:true};
      await writeFile(resolve(artifactDir,'result.json'),JSON.stringify(normalized,null,2),{mode:0o600});return normalized;
    } catch {
      // A reported usage limit is the cause, not a malformed result. It is still started work.
      // Then a provider that stopped at its turn limit (dev.84, H9): a known end, not a malformed result.
      // Only when the end is bound to this invocation (review fix): the final names a session, and it is
      // the one accounting accepted above, so the resumed session if this invocation resumed one. A
      // missing or different session leaves the end uncertain, and no unbound session is ever kept.
      const ended = finalEnding(spec, run.stdout), bound = Boolean(ended?.sessionId) && accountingResult?.sessionId === ended.sessionId && (!spec.sessionId || ended.sessionId === spec.sessionId);
      const turnLimit = !exhausted(limits) && ended?.subtype === 'error_max_turns' && bound ? { ...ended, maxTurns: spec.maxTurns ?? null } : null;
      const error = exhausted(limits) ? usageLimitError(spec.provider)
        : turnLimit ? Object.assign(new ProviderError(`${spec.provider} stopped at its turn limit (${turnLimitText(turnLimit)}); the step did not finish and returned no result`,{started:true,code:'MAX_TURNS'}), { turnLimit })
        : new ProviderError(`Provider did not produce a complete validated result; inspect private artifacts${ended ? ` (${spec.provider} ended with ${ended.subtype ?? 'an unknown result'}${ended.turns != null ? ` after ${ended.turns} turns` : ''}${ended.costUsd != null ? `, reported cost $${ended.costUsd.toFixed(3)}` : ''}${bound ? '' : ended.sessionId ? ', in a session other than the one this invocation resumed' : ', without a session'}; its output is in the attempt's provider stdout.jsonl)` : ''}`,{started:true,code:'INVALID_RESULT'});
      error.accountingResult = { ...(accountingResult ?? { provider: spec.provider, model: spec.model, sessionId: spec.sessionId ?? null }), ...(limits.length ? { limits } : {}) }; throw error;
    }
  }
  async function invoke(spec, options = {}) {
    checkSpec(spec);
    try { return await invokeOnce(spec, options); }
    catch (error) {
      // No resumed session changes provider. Only positively unstarted failures
      // permit one explicitly configured subscription fallback; uncertain output
      // and model failures never replay work on a second provider. Reviewers may
      // share the builder's model family; the receipt records the actual family.
      if (!spec.allowFallback || !spec.fallback || spec.sessionId || options.signal?.aborted || !(error instanceof ProviderError) || error.started || ['CANCELLED','BILLING_UNVERIFIED','MODEL_NOT_ALLOWED','SCHEMA_UNSUPPORTED'].includes(error.code)) throw error;
      const fallback = { ...spec, ...spec.fallback, role:spec.role, schema:spec.schema, prompt:spec.prompt, cwd:spec.cwd, timeoutMs:spec.timeoutMs, readOnly:spec.readOnly,
        artifactDir:resolve(spec.artifactDir,'fallback'), sessionId:undefined, allowFallback:false, fallback:undefined, allowedModels:spec.fallback.allowedModels ?? spec.allowedModels };
      checkSpec(fallback);
      const result = await invokeOnce(fallback, options);
      return { ...result, fallback:{ fromProvider:spec.provider, fromModel:spec.model, reason:error.code, beforeModelStart:true } };
    }
  }
  return {preflight,invoke};
}
const adapter=createProviderAdapter();export const preflight=adapter.preflight,invoke=adapter.invoke;
