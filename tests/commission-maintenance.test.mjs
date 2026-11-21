import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { doctor, importGitHubTask } from '../starter/factory/workflows/commission.mjs';
import { operationalTick, runMaintenanceAction, scheduleGrantDigest } from '../starter/factory/workflows/maintenance.mjs';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'factotum-maintenance-')), root = join(base, 'repo'), remote = join(base, 'remote.git'), stateDir = join(base, 'state'); mkdirSync(root); const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  git(['init','-q','-b','main']); git(['config','user.email','fictional@example.invalid']); git(['config','user.name','Fictional']); writeFileSync(join(root,'fixture.txt'),'fictional'); git(['add','.']); git(['commit','-qm','Fictional baseline']); execFileSync('git',['init','--bare','-q',remote]); git(['remote','add','origin',remote]); git(['push','-q','origin','main']);
  initProject({ stateDir, root, name:'Fictional', supervisor:'systemd', workflow:{version:1,start:'done',nodes:{done:{kind:'end',outcome:'completed'}}} });
  const store = new Store(stateDir), config = {version:1,mode:'delivery', repository:{slug:'fictional/project',account:'fictional',target:'main',remote:'origin'},providers:{planner:{provider:'codex',model:'fictional'},builder:{provider:'codex',model:'fictional'},reviewer:{provider:'claude',model:'fictional'}},policy:{maxFlows:1},checks:[{id:'fixture',argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:60000}], mainChecks:[{id:'main',argv:[process.execPath,'-e',"require('node:fs').readFileSync('fixture.txt')"],timeoutMs:60000}],context:{files:[],maxChars:1000},resources:{coordinatorPath:join(base,'host.sqlite')},backupRoot:join(base,'backups')}; store.setMeta('config',config); store.setMeta('configDigest',digest(config));
  t.after(()=>{store.close();rmSync(base,{recursive:true,force:true});}); return {base,root,store,stateDir,config,git};
}
const providerPreflight = async spec => ({provider:spec.provider,version:'fictional',billing:{mode:'subscription'},capabilities:{structuredOutput:true,readOnly:true}});
const forgeTransport = async () => ({permissions:{push:true}});
test('doctor checks live model defaults and refuses a concurrent model change', async t => {
  const f = fixture(t), { changeWorkflow } = await import('../starter/factory/core/configuration.mjs');
  f.store.setMeta('workflow', changeWorkflow(f.config));
  f.store.setMeta('modelDefaults', { standard: { plan: { model: 'live-planner', effort: 'high' } } });
  const selected = [];
  const first = await doctor(f.stateDir, { forgeTransport, providerPreflight: async spec => { selected.push(spec); return providerPreflight(spec); } });
  assert.equal(first.ready, true, JSON.stringify(first));
  assert.ok(selected.some(spec => spec.role === 'planner' && spec.model === 'live-planner' && spec.effort === 'high'));
  let changed = false;
  const second = await doctor(f.stateDir, { forgeTransport, providerPreflight: async spec => {
    if (!changed) { changed = true; f.store.setMeta('modelDefaults', { standard: { plan: { model: 'new-live-planner' } } }); }
    return providerPreflight(spec);
  } });
  assert.equal(second.ready, false); assert.match(second.reasons.join(), /model defaults changed during commissioning/);
});
test('doctor actually verifies clean remote main and checks without altering root checkout', async t => { const f = fixture(t), before = f.git(['rev-parse','HEAD']); const result = await doctor(f.stateDir,{providerPreflight,forgeTransport}); assert.equal(result.ready,true,JSON.stringify(result)); assert.equal(Object.keys(result.providers).length,3); assert.equal(f.store.meta('mainHealth').status,'green'); assert.equal(f.git(['rev-parse','HEAD']),before); assert.equal(f.git(['status','--porcelain']),''); });
test('doctor refuses unsupported provider, missing checks, dirty checkout and unqualified auto merge', async t => { const f = fixture(t); let result = await doctor(f.stateDir,{providerPreflight:async()=>{throw new Error('unavailable');},forgeTransport}); assert.equal(result.ready,false); assert.equal(result.providers.builder.ready,false); f.store.setMeta('config',{...f.config,mainChecks:[]}); result=await doctor(f.stateDir,{providerPreflight,forgeTransport}); assert.match(result.reasons.join(),/mainChecks/); f.store.setMeta('config',f.config);writeFileSync(join(f.root,'dirty'),'operator work'); result=await doctor(f.stateDir,{providerPreflight,forgeTransport});assert.match(result.reasons.join(),/clean/); });
test('GitHub import preserves source revision and never grants approval', async t => { const f=fixture(t); const task=await importGitHubTask(f.stateDir,3,{transport:async()=>({title:'Fictional task',state:'open',body:'```factotum-task\n'+JSON.stringify({version:1,acceptance:['Fictional acceptance'],dependencies:[2],risk:'ordinary'})+'\n```',labels:[],updated_at:'2026-01-01',html_url:'https://example.invalid/3'})});assert.equal(task.id,'github:3');assert.equal(task.approvedRevision,null);assert.deepEqual(task.dependencies,['github:2']);assert.ok(task.source.revision); });
test('schedule tick atomically admits scoped maintenance despite unknown main, then preserves stopped ownership', async t=>{const f=fixture(t),createdAt=new Date(Date.now()-2000).toISOString();const schedule={id:'main-check',enabled:true,type:'interval',anchorMs:Date.now()-2000,everyMs:1000,operation:'main.verify',createdAt};f.store.put('schedule',schedule);await operationalTick(f.store);const flow=f.store.all('flow')[0],task=f.store.get('task',flow.taskId);assert.equal(flow.kind,'maintenance');assert.equal(task.approvalKind,'schedule');assert.equal(task.scheduleRevision,scheduleGrantDigest(f.store.get('schedule',schedule.id)));assert.equal(flow.workflow.nodes.run.action.operation,'main.verify');flow.state='stopped';f.store.put('flow',flow);await operationalTick(f.store);assert.equal(f.store.all('flow').length,1);});
test('manual maintenance requires explicit scoped grant and paused projects dispatch no jobs', async t=>{const f=fixture(t);f.store.put('job',{id:'manual',operation:'retrospective',payload:{},status:'queued'});await operationalTick(f.store);assert.equal(f.store.get('job','manual').status,'revoked');assert.equal(f.store.all('flow').length,0);f.store.put('job',{id:'manual',operation:'retrospective',payload:{},status:'queued',grant:{actor:'operator',note:'Inspect fictional metrics',configDigest:f.store.meta('configDigest')}});f.store.setMeta('paused',true);await operationalTick(f.store);assert.equal(f.store.all('flow').length,0);f.store.setMeta('paused',false);await operationalTick(f.store);assert.equal(f.store.all('flow').length,1);});
test('maintenance backup creates real consistent snapshot and reconciles repeat, audit stays unapproved', async t=>{const f=fixture(t),project=f.store.meta('project');const intent={projectRoot:f.root,cwd:f.root,action:{operation:'maintenance.backup',stateDir:f.stateDir,projectId:project.projectId,flowId:'backup',config:f.config}};const first=await runMaintenanceAction(intent);assert.equal(first.route,'pass');const repeated=await runMaintenanceAction(intent);assert.equal(repeated.backup.reconciled,true);assert.equal(JSON.parse(readFileSync(join(first.backup.destination,'backup.json'))).projectId,project.projectId);const audit=await runMaintenanceAction({...intent,action:{...intent.action,operation:'audit',artifactDir:join(f.base,'audit')}},{providerInvoke:async()=>({provider:'fictional',result:{verdict:'revise',summary:'Fictional audit',findings:[{severity:'low',file:'fixture.txt',line:1,message:'Fictional improvement'}]}})});assert.equal(audit.findings[0].approved,false);assert.ok(audit.findings[0].evidenceDigest);});
test('main verification preserves dirty evidence in its own workspace and leaves user checkout untouched', async t=>{const f=fixture(t),project=f.store.meta('project');const config={...f.config,mainChecks:[{id:'unsafe-check',argv:[process.execPath,'-e',"require('node:fs').writeFileSync('fixture.txt','changed by fictional check')"],timeoutMs:60000}]};const result=await runMaintenanceAction({projectRoot:f.root,cwd:f.root,action:{operation:'main.verify',stateDir:f.stateDir,projectId:project.projectId,flowId:'dirty-check',config}});assert.equal(result.mainHealth.status,'unknown');assert.equal(result.mainHealth.unchanged,false);assert.equal(result.obligations.length,1);assert.equal(readFileSync(join(f.root,'fixture.txt'),'utf8'),'fictional');assert.equal(f.git(['status','--porcelain']),'');});
test('doctor rejects global-only identity before provider checks, requires both scoped fields and accepts local repair',async t=>{
 const f=fixture(t),globalConfig=join(f.base,'global.gitconfig');f.git(['config','--file',globalConfig,'user.name','Fictional Global']);f.git(['config','--file',globalConfig,'user.email','global@example.invalid']);f.git(['config','--unset','user.name']);f.git(['config','--unset','user.email']);
 const saved=Object.fromEntries(['GIT_CONFIG_GLOBAL','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'].map(k=>[k,process.env[k]]));Object.assign(process.env,{GIT_CONFIG_GLOBAL:globalConfig,GIT_AUTHOR_NAME:'Ambient fictional author',GIT_AUTHOR_EMAIL:'ambient@example.invalid',GIT_COMMITTER_NAME:'Ambient fictional committer',GIT_COMMITTER_EMAIL:'ambient@example.invalid'});t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 let preflights=0;const options={forgeTransport,providerPreflight:async spec=>{preflights++;return providerPreflight(spec);}};
 assert.equal(f.git(['config','--get','user.email']).trim(),'global@example.invalid');let result=await doctor(f.stateDir,options);assert.equal(result.ready,false);assert.match(result.reasons.join(),/user.name, user.email/);assert.equal(preflights,0);assert.equal(f.store.meta('commissioning').ready,false);
 f.git(['config','--local','user.name','Fictional Local']);result=await doctor(f.stateDir,options);assert.equal(result.ready,false);assert.match(result.reasons.join(),/user.email/);assert.equal(preflights,0);
 f.git(['config','--local','user.email','']);result=await doctor(f.stateDir,options);assert.equal(result.ready,false);assert.match(result.reasons.join(),/user.email/);
 f.git(['config','--local','user.email','local@example.invalid']);result=await doctor(f.stateDir,options);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(preflights,3);assert.equal(f.store.meta('commissioning').ready,true);
});

test('doctor waits for another project\'s heavy permit, names its holder, and proceeds once it is released', async t => {
  const f = fixture(t), { HostResources } = await import('../starter/factory/operations/resources.mjs'), { processIdentity } = await import('../starter/factory/core/process-identity.mjs');
  const coordinator = new HostResources(f.config.resources.coordinatorPath); t.after(() => coordinator.close());
  const held = coordinator.acquire({ projectId: 'other-project', flowId: 'other-flow', attemptId: 'other-attempt', owner: processIdentity() });
  assert.ok(held);
  // Bounded wait: with a short bound the reason names the holder instead of a bare timeout.
  let result = await doctor(f.stateDir, { providerPreflight, forgeTransport, resourceWaitMs: 1500 });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join(), /doctor host resource wait exhausted after \d+ s; heavy-work held by project other-project, flow other-flow, attempt other-attempt since /);
  // A release during the wait lets doctor proceed; the waiting callback saw the holder.
  const waits = [];
  setTimeout(() => coordinator.release(held.resource, held.token), 1500);
  result = await doctor(f.stateDir, { providerPreflight, forgeTransport, onResourceWait: wait => waits.push(wait) });
  assert.equal(result.ready, true, JSON.stringify(result.reasons));
  assert.equal(waits.length, 2); assert.match(waits[0].holders, /project other-project/);
  assert.equal(waits[1], null, 'acquisition clears the reported holder before verification');
});

test('a requested doctor shows who holds the heavy permit while it waits', async t => {
  const { runDoctorRequest } = await import('../starter/factory/operations/doctor-request.mjs');
  const f = fixture(t);
  f.store.setMeta('doctorRequest', { id: 'request-1', status: 'queued', requestedAt: new Date().toISOString() });
  let release;
  let acquire;
  const task = runDoctorRequest(f.store, { doctor: async (stateDir, { onResourceWait }) => { onResourceWait({ resource: 'heavy-work', holders: 'project other-project, flow f, attempt a since t', since: 'now' }); await new Promise(resolve => { acquire = resolve; }); onResourceWait(null); await new Promise(resolve => { release = resolve; }); return { ready: true, reasons: [] }; } });
  assert.equal(f.store.meta('doctorRequest').waitingFor.holders, 'project other-project, flow f, attempt a since t');
  acquire(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.meta('doctorRequest').status, 'running'); assert.equal(f.store.meta('doctorRequest').waitingFor, undefined);
  // Clearing on acquisition removes the stale holder while doctor keeps running.
  await Promise.resolve();
  release(); await task;
  assert.equal(f.store.meta('doctorRequest').status, 'passed'); assert.equal(f.store.meta('doctorRequest').waitingFor, undefined);
});

// dev.85: doctor's provider failures named only the role; a transient probe failure failed commissioning outright.
const { ProviderError } = await import('../starter/factory/adapters/providers/index.mjs');
const probeError = (message, { code = 'PREFLIGHT_FAILED', failure, call, processCode, stderr = '' } = {}) => Object.defineProperty(Object.assign(new ProviderError(message, { code }), { ...(failure ? { failure } : {}), ...(call ? { call } : {}), ...(processCode ? { processCode } : {}) }), 'stderr', { value: stderr });
const plannerFailing = (errors, calls) => async spec => { if (spec.role === 'planner') { calls.push(spec.role); const next = errors.shift(); if (next) throw next; } return providerPreflight(spec); };

test('dev.85: a failed provider probe names the role, provider, model, kind of failure, call and a redacted excerpt; auth is not retried', async t => {
  const f = fixture(t), secret = 'sk-fictional-doctor-secret-9876543210', saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = secret;
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  const calls = [];
  const result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([probeError('codex subscription billing route could not be verified (auth status exit code 1)', { code: 'BILLING_UNVERIFIED', failure: 'auth', call: 'auth status', stderr: `Account: person@example.invalid; token ${secret}` })], calls) });
  assert.equal(result.ready, false);
  assert.equal(calls.length, 1, 'an auth failure is not retried');
  const planner = result.providers.planner;
  assert.equal(planner.provider, 'codex'); assert.equal(planner.model, 'fictional'); assert.equal(planner.ready, false);
  assert.equal(planner.failure, 'auth'); assert.equal(planner.call, 'auth status'); assert.equal(planner.phase, 'preflight'); assert.equal(planner.attempts, 1); assert.equal(planner.retried, false);
  // The auth call's output is never reported, even when the error carries it (review fix 1).
  assert.equal(planner.error, 'codex subscription billing route could not be verified (auth status exit code 1)');
  assert.ok(!JSON.stringify(result).includes('person@example.invalid'));
  const reason = result.reasons.find(r => r.startsWith('planner provider preflight failed'));
  assert.match(reason, /^planner provider preflight failed for codex\/fictional: auth problem during auth status \(codex subscription billing route could not be verified/);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.providers.builder.ready, true, 'the other roles are still probed');
  // Another call's stderr is reported, bounded and with the known secret redacted.
  const again = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([probeError('codex CLI version check failed (exit code 2)', { code: 'PROVIDER_REJECTED', failure: 'invalid-result', call: '--version', stderr: `token ${secret} rejected` })], []) });
  assert.match(again.providers.planner.error, /^codex CLI version check failed \(exit code 2\)\nstderr: token \[redacted\] rejected$/);
  assert.ok(!JSON.stringify(again).includes(secret));
});

test('dev.85: a probe that times out is retried once, and a pass on the retry is recorded', async t => {
  const f = fixture(t), calls = [];
  const timeout = () => probeError('codex CLI preflight failed before model launch: codex auth status timed out after 15 s', { failure: 'timeout', call: 'auth status', processCode: 'TIMEOUT' });
  let result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([timeout()], calls) });
  assert.equal(result.ready, true, JSON.stringify(result.reasons));
  assert.equal(calls.length, 2);
  assert.equal(result.providers.planner.ready, true);
  assert.deepEqual({ ...result.providers.planner.retry, firstError: undefined }, { attempts: 2, firstFailure: 'timeout', firstError: undefined });
  assert.match(result.providers.planner.retry.firstError, /timed out after 15 s/);
  // Two timeouts: commissioning fails, and the reason says it was retried.
  calls.length = 0;
  result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([timeout(), timeout()], calls) });
  assert.equal(result.ready, false); assert.equal(calls.length, 2);
  assert.equal(result.providers.planner.failure, 'timeout'); assert.equal(result.providers.planner.attempts, 2); assert.equal(result.providers.planner.retried, true);
  assert.ok(result.reasons.some(r => /^planner provider preflight failed for codex\/fictional: timed out during auth status, after one retry \(codex CLI preflight failed before model launch: codex auth status timed out after 15 s\)$/.test(r)), JSON.stringify(result.reasons));
});

test('dev.85: missing CLIs, configuration and invalid results are not retried; a transient process error is', async t => {
  const f = fixture(t);
  for (const [error, failure, attempts] of [
    [probeError('codex CLI preflight failed before model launch: the codex CLI could not be started (ENOENT)', { failure: 'missing-cli', call: '--version', processCode: 'ENOENT' }), 'missing-cli', 1],
    [new ProviderError('Model is outside the configured allowlist', { code: 'MODEL_NOT_ALLOWED' }), 'configuration', 1],
    [probeError('Installed codex CLI lacks required isolation/structured-output capabilities: missing --output-schema', { code: 'PROVIDER_REJECTED', failure: 'invalid-result', call: '--help' }), 'invalid-result', 1],
    [probeError('codex CLI preflight failed before model launch: codex --version failed (EAGAIN)', { failure: 'process-error', call: '--version', processCode: 'EAGAIN' }), 'process-error', 2],
  ]) {
    const calls = [];
    const result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([error, error], calls) });
    assert.equal(result.providers.planner.failure, failure); assert.equal(calls.length, attempts, failure); assert.equal(result.providers.planner.attempts, attempts);
  }
});

test('dev.85: a failed fallback probe is named as the fallback, with its own provider and model', async t => {
  const f = fixture(t);
  f.store.setMeta('config', { ...f.config, providers: { ...f.config.providers, reviewer: { provider: 'claude', model: 'fictional', allowFallback: true, fallback: { provider: 'codex', model: 'fictional-backup' } } } });
  const result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: async spec => { if (spec.role === 'reviewer' && spec.provider === 'codex') throw probeError('codex CLI preflight failed before model launch: the codex CLI could not be started (ENOENT)', { failure: 'missing-cli', call: '--version', processCode: 'ENOENT' }); return providerPreflight(spec); } });
  assert.equal(result.providers.reviewer.ready, false); assert.equal(result.providers.reviewer.phase, 'fallback preflight');
  assert.equal(result.providers.reviewer.fallback.provider, 'codex'); assert.equal(result.providers.reviewer.fallback.model, 'fictional-backup'); assert.equal(result.providers.reviewer.fallback.failure, 'missing-cli');
  assert.ok(result.reasons.some(r => /^reviewer fallback provider preflight failed for codex\/fictional-backup: CLI missing during --version/.test(r)), JSON.stringify(result.reasons));
});

test('dev.85: doctor reports each long phase as it enters it, including the permit wait and who holds it', async t => {
  const f = fixture(t), { HostResources } = await import('../starter/factory/operations/resources.mjs'), { processIdentity } = await import('../starter/factory/core/process-identity.mjs');
  const coordinator = new HostResources(f.config.resources.coordinatorPath); t.after(() => coordinator.close());
  const held = coordinator.acquire({ projectId: 'other-project', flowId: 'other-flow', attemptId: 'other-attempt', owner: processIdentity() });
  setTimeout(() => coordinator.release(held.resource, held.token), 1200);
  const phases = [];
  const result = await doctor(f.stateDir, { providerPreflight, forgeTransport, onProgress: (phase, detail) => phases.push([phase, detail]) });
  assert.equal(result.ready, true, JSON.stringify(result.reasons));
  const names = phases.map(([phase]) => phase);
  assert.deepEqual(names.filter(name => name.startsWith('probe of')), ['probe of planner (codex/fictional)', 'probe of builder (codex/fictional)', 'probe of reviewer (claude/fictional)']);
  assert.deepEqual(names.filter(name => !name.startsWith('probe of')), ['forge check', 'checkout check', 'permit wait', 'main verification']);
  assert.match(phases.find(([phase]) => phase === 'permit wait')[1], /^waiting up to 65 min for heavy-work, held by project other-project, flow other-flow, attempt other-attempt/);
  assert.equal(phases.find(([phase]) => phase.startsWith('probe of'))[1], 'attempt 1 of 2');
});

test('dev.85: doctor\'s time bound covers the permit wait, every probe with its retry and every main check, under a hard cap', async t => {
  const f = fixture(t), { doctorTimeBound, PROBE_BOUND_MS, DOCTOR_TIME_CAP_MS } = await import('../starter/factory/workflows/commission.mjs');
  const { LEASE_HOLD_BOUND_MS } = await import('../starter/factory/operations/resources.mjs');
  let bound = doctorTimeBound(f.stateDir);
  assert.equal(bound.parts.permitWaitMs, LEASE_HOLD_BOUND_MS); assert.equal(bound.parts.probes, 3);
  assert.ok(bound.parts.probesMs >= 3 * 2 * PROBE_BOUND_MS, 'two attempts of every probe');
  assert.ok(bound.parts.mainChecksMs >= 60000);
  assert.ok(bound.timeoutMs >= LEASE_HOLD_BOUND_MS + bound.parts.probesMs + 60000 && bound.capped === false);
  // A fallback is a probe of its own; main check retries count.
  f.store.setMeta('config', { ...f.config, providers: { ...f.config.providers, reviewer: { provider: 'claude', model: 'fictional', allowFallback: true, fallback: { provider: 'codex', model: 'b' } } }, policy: { ...f.config.policy, mainInfrastructureRetries: 2 } });
  const more = doctorTimeBound(f.stateDir);
  assert.equal(more.parts.probes, 4); assert.ok(more.parts.mainChecksMs >= 3 * 60000);
  // Very long main checks are capped.
  f.store.setMeta('config', { ...f.config, mainChecks: [{ id: 'long', argv: ['true'], timeoutMs: 10 * 3_600_000 }] });
  bound = doctorTimeBound(f.stateDir);
  assert.equal(bound.timeoutMs, DOCTOR_TIME_CAP_MS); assert.equal(bound.capped, true);
});

// dev.85 review fixes 1 and 2.
test('dev.85 review: an auth status call that times out keeps none of its output, through the real adapter into doctor', async t => {
  const f = fixture(t), { createProviderAdapter } = await import('../starter/factory/adapters/providers/index.mjs');
  const help = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
  const transport = async (binary, args, opts) => {
    if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.169.0', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (binary === 'codex' && args.includes('status')) throw Object.defineProperty(Object.assign(new ProviderError(`${opts.label} timed out after 15 s`, { started: true, code: 'TIMEOUT' }), {}), 'stderr', { value: 'Account: person@example.invalid; home /home/person' });
    return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
  };
  const adapter = createProviderAdapter({ transport }), progress = [];
  const result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: adapter.preflight, onProgress: (phase, detail) => progress.push(`${phase} ${detail}`) });
  assert.equal(result.ready, false); assert.equal(result.providers.reviewer.ready, true, 'the claude reviewer passes');
  assert.equal(result.providers.planner.failure, 'timeout'); assert.equal(result.providers.planner.call, 'auth status'); assert.equal(result.providers.planner.retried, true);
  assert.equal(result.providers.planner.error, 'codex CLI preflight failed before model launch: codex auth status timed out after 15 s');
  const stored = JSON.stringify([result, f.store.meta('commissioning'), f.store.db.prepare("SELECT payload FROM events WHERE type = 'project.doctor'").all(), progress]);
  for (const leaked of ['person@example.invalid', '/home/person']) assert.ok(!stored.includes(leaked), leaked);
});

test('dev.85 review: known secrets are redacted from the whole of every doctor report: progress, reasons, provider entries and the event', async t => {
  const f = fixture(t), secret = 'fictionalsecretmodel1', saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = secret;
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  f.store.setMeta('config', { ...f.config, providers: { ...f.config.providers, planner: { provider: 'codex', model: secret } } });
  const timeout = () => probeError('codex CLI preflight failed before model launch: codex --version timed out after 15 s', { failure: 'timeout', call: '--version', processCode: 'TIMEOUT' });
  const progress = [];
  const result = await doctor(f.stateDir, { forgeTransport, retryPauseMs: 0, providerPreflight: plannerFailing([timeout(), timeout()], []), onProgress: (phase, detail) => progress.push([phase, detail]) });
  assert.equal(result.ready, false);
  assert.ok(progress.some(([phase]) => phase === 'probe of planner (codex/[redacted])'), JSON.stringify(progress));
  assert.ok(result.reasons.some(reason => reason.startsWith('planner provider preflight failed for codex/[redacted]: timed out during --version, after one retry')), JSON.stringify(result.reasons));
  assert.equal(result.providers.planner.model, '[redacted]');
  const events = f.store.db.prepare("SELECT payload FROM events WHERE type = 'project.doctor'").all();
  for (const [name, value] of [['progress', progress], ['result', result], ['stored record', f.store.meta('commissioning')], ['event', events]]) assert.ok(!JSON.stringify(value).includes(secret), `${name} carries the secret`);
});

test('dev.85 review: doctor\'s time bound includes workspace setup at its configured or default timeout', async t => {
  const f = fixture(t), { doctorTimeBound } = await import('../starter/factory/workflows/commission.mjs'), { SETUP_TIMEOUT_MS } = await import('../starter/factory/adapters/workspace/index.mjs');
  assert.equal(doctorTimeBound(f.stateDir).parts.setupMs, 0);
  f.store.setMeta('config', { ...f.config, workspace: { setup: [['npm', 'ci'], ['npm', 'run', 'build']] } });
  let bound = doctorTimeBound(f.stateDir);
  assert.equal(SETUP_TIMEOUT_MS, 30 * 60_000); assert.equal(bound.parts.setupMs, 2 * (SETUP_TIMEOUT_MS + 1000));
  f.store.setMeta('config', { ...f.config, workspace: { setup: [['npm', 'ci']], setupTimeoutMs: 90 * 60_000 } });
  bound = doctorTimeBound(f.stateDir);
  assert.equal(bound.parts.setupMs, 90 * 60_000 + 1000);
  assert.ok(bound.timeoutMs >= bound.parts.permitWaitMs + bound.parts.probesMs + bound.parts.setupMs + bound.parts.mainChecksMs, 'a 90-minute setup fits inside the doctor limit');
});
// dev.104: doctor checks that an attempt unit runs the service's node and git
// (operations/attempt-environment-probe.mjs, tested with stand-ins in attempt-environment.test.mjs).
test('doctor blocks when an attempt unit would run a different node than the project service, and records what it found', async t => {
  const f = fixture(t), asked = [];
  const reason = 'An attempt unit resolves node to /fictional/shims/node, but the project service resolves it to /fictional/node24/bin/node (service PATH from factotum-project-fictiona.service), so checks and providers would run a different node than the service.';
  const attemptEnvironmentProbe = async options => { asked.push(options); return { reasons: [reason], warnings: [], record: { status: 'differs', pathFrom: 'factotum-project-fictiona.service' } }; };
  const result = await doctor(f.stateDir, { providerPreflight, forgeTransport, attemptEnvironmentProbe });
  assert.equal(result.ready, false); assert.ok(result.reasons.includes(reason), result.reasons.join(' | '));
  assert.equal(asked.length, 1); assert.equal(asked[0].stateDir, f.stateDir); assert.equal(asked[0].project.projectId, f.store.meta('project').projectId);
  assert.deepEqual(f.store.meta('commissioning').attemptEnvironment, { status: 'differs', pathFrom: 'factotum-project-fictiona.service' });
  const same = await doctor(f.stateDir, { providerPreflight, forgeTransport, attemptEnvironmentProbe: async () => ({ reasons: [], warnings: [], record: { status: 'same' } }) });
  assert.equal(same.ready, true, JSON.stringify(same.reasons)); assert.equal(same.attemptEnvironment.status, 'same');
  // With faked providers and no probe given, no transient unit is started.
  const unprobed = await doctor(f.stateDir, { providerPreflight, forgeTransport });
  assert.equal(unprobed.ready, true); assert.equal(unprobed.attemptEnvironment, undefined);
});
// dev.105: doctor reads the result the project service recorded. During `upgrade apply` the service
// is stopped and has not checked this code: unverified, a warning with the next-start message, and
// doctor still passes. A difference the service recorded under this code blocks.
test('doctor with the service stopped and no check for this release is unverified, never refused; a recorded difference blocks', async t => {
  const f = fixture(t), { recordedAttemptEnvironment, NOT_YET_CHECKED } = await import('../starter/factory/operations/attempt-environment-record.mjs'), { executorDigest } = await import('../starter/factory/core/effects.mjs');
  f.store.setMeta('attemptEnvironmentCheck', { status: 'same', checkedAt: '2026-11-20T10:00:00.000Z', executorDigest: 'the-release-before', reasons: [], warnings: [] });
  const upgrading = await doctor(f.stateDir, { providerPreflight, forgeTransport, attemptEnvironmentProbe: recordedAttemptEnvironment });
  assert.equal(upgrading.ready, true, JSON.stringify(upgrading.reasons)); assert.ok(upgrading.warnings.includes(NOT_YET_CHECKED), upgrading.warnings.join(' | '));
  assert.equal(upgrading.attemptEnvironment.status, 'unverified');
  const reason = 'An attempt unit resolves node to /fictional/shims/node, but the project service resolves it to /fictional/node24/bin/node';
  f.store.setMeta('attemptEnvironmentCheck', { status: 'differs', checkedAt: '2026-11-21T10:00:00.000Z', executorDigest: executorDigest(), reasons: [reason], warnings: [] });
  const differs = await doctor(f.stateDir, { providerPreflight, forgeTransport, attemptEnvironmentProbe: recordedAttemptEnvironment });
  assert.equal(differs.ready, false); assert.ok(differs.reasons.includes(reason)); assert.equal(differs.attemptEnvironment.status, 'differs');
});
