import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {until} from './helpers.mjs';
import {createProviderAdapter,ProviderError,subscriptionEnvironment,runProcess,BUILD_SCHEMA,REVIEW_SCHEMA,validateSchema} from '../starter/factory/adapters/providers/index.mjs';
const session='00000000-0000-0000-0000-000000000001';
const help='--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
async function fixture(t,provider='codex',changes={}){const dir=await mkdtemp(join(tmpdir(),'factotum-provider-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'work'));return {provider,model:'test-model',role:'builder',prompt:'Fictional task',cwd:join(dir,'work'),artifactDir:join(dir,'private'),timeoutMs:60000,...changes};}
function fake(provider,events,options={}){const calls=[];const transport=async(binary,args,opts)=>{calls.push({binary,args,opts});if(args.includes('--version'))return {code:0,stdout:options.version ?? (provider === 'codex' ? 'codex-cli 0.169.0' : '2.1.323'),stderr:''};if(args.includes('--help'))return {code:0,stdout:options.help??help,stderr:''};if(args.includes('status'))return {code:0,stdout:options.auth??(provider==='codex'?'Logged in using ChatGPT':JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'})),stderr:''};if(options.error)throw options.error;return {code:options.code??0,stdout:typeof events==='string'?events:events.map(e=>JSON.stringify(e)).join('\n'),stderr:''};};return {calls,adapter:createProviderAdapter({transport,environment:{HOME:'/fictional',PATH:'/bin',ANTHROPIC_API_KEY:'secret',OPENAI_BASE_URL:'https://invalid'}})};}
const codexEvents=[{type:'thread.started',thread_id:session},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'implemented',summary:'Done'})}},{type:'turn.completed',usage:{input_tokens:4,cached_input_tokens:0,output_tokens:2}}];
const claudeEvents=[{type:'system',subtype:'init',session_id:session},{type:'result',subtype:'success',is_error:false,session_id:session,usage:{input_tokens:4,cached_input_tokens:0,output_tokens:2},structured_output:{verdict:'pass',summary:'Checked',findings:[]}}];
test('environment removes keys, endpoints, cloud routes and inherited agent config',()=>{assert.deepEqual(Object.keys(subscriptionEnvironment({HOME:'/x',PATH:'/bin',ANTHROPIC_API_KEY:'x',AWS_PROFILE:'prod',OPENAI_BASE_URL:'x',NODE_OPTIONS:'evil',CLAUDE_CODE_USE_BEDROCK:'1'})).sort(),['HOME','PATH','NO_COLOR','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_DISABLE_AUTO_MEMORY'].sort());});
test('Codex complete receipt, private artifacts and explicit resume sandbox',async t=>{const spec=await fixture(t,'codex',{sessionId:session});const {adapter,calls}=fake('codex',codexEvents);const result=await adapter.invoke(spec);assert.equal(result.final,true);assert.equal(result.billing.actualMicros,null);assert.equal(result.usageObservation.tokenSemantics,'session-cumulative');const call=calls.at(-1);assert.ok(call.args.includes('resume'));assert.ok(call.args.includes('sandbox_mode="workspace-write"'));assert.ok(call.opts.input.startsWith('Repository: ')&&call.opts.input.endsWith(spec.prompt));assert.ok(!call.args.includes(spec.prompt));assert.deepEqual(JSON.parse(await readFile(join(spec.artifactDir,'result.json'),'utf8')),result);});
test('Claude reviewer uses enforced read tool allowlist, fresh session and structured result',async t=>{const spec=await fixture(t,'claude',{role:'reviewer',readOnly:true});const {adapter,calls}=fake('claude',claudeEvents);const r=await adapter.invoke(spec);assert.equal(r.permissions.enforced,'provider-tool-allowlist');const args=calls.at(-1).args;assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep');assert.ok(!args.includes('--resume'));assert.ok(args.includes('--safe-mode'));});
test('planner and reviewer cannot inherit builder session or request writes',async t=>{const {adapter,calls}=fake('codex',codexEvents);for(const changes of [{role:'reviewer',sessionId:session},{role:'planner',readOnly:false}])await assert.rejects(adapter.invoke(await fixture(t,'codex',changes)),/fresh session|read-only/);assert.equal(calls.length,0);});
test('unverifiable API billing routes rejected before model launch',async t=>{for(const provider of ['codex','claude']){const {adapter,calls}=fake(provider,[],{auth:provider==='codex'?'Logged in using API key':JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'})});await assert.rejects(adapter.invoke(await fixture(t,provider)),e=>e.code==='BILLING_UNVERIFIED'&&!e.started);assert.ok(!calls.some(c=>c.args.includes('--json-schema')||c.args.includes('--output-schema')));}});
test('missing installed capability fails closed',async t=>{const {adapter}=fake('codex',[],{help:'--json'});await assert.rejects(adapter.invoke(await fixture(t)),/lacks required/);});
test('malformed, partial, failed and schema-invalid model output never enables retry',async t=>{for(const events of ['not-json',[codexEvents[0]],codexEvents.slice(0,2),[...codexEvents,{type:'turn.failed'}],codexEvents.map(e=>e.type==='item.completed'?{...e,item:{type:'agent_message',text:'{"status":"implemented"}'}}:e)]){const {adapter}=fake('codex',events);await assert.rejects(adapter.invoke(await fixture(t)),e=>e.code==='INVALID_RESULT'&&e.started&&!e.safeToRetry);}});
test('strict schema validates full nested output',()=>{assert.throws(()=>validateSchema({verdict:'pass',summary:'ok',findings:[{severity:'high',file:'x',line:-1,message:'x'}]},REVIEW_SCHEMA));assert.throws(()=>validateSchema({status:'implemented',summary:'x',extra:true},BUILD_SCHEMA));assert.throws(()=>validateSchema({}, {oneOf:[]}));});
test('actual subprocess cancellation and timeout terminate owned process group',async()=>{for(const mode of ['timeout','cancel']){const controller=new AbortController();if(mode==='cancel')setTimeout(()=>controller.abort(),80);await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{env:subscriptionEnvironment(),signal:controller.signal,timeoutMs:mode==='timeout'?80:2000}),e=>e.code===(mode==='timeout'?'TIMEOUT':'CANCELLED')&&e.started&&!e.safeToRetry);}});
test('already cancelled signal never launches provider',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(runProcess('does-not-exist',[],{signal:controller.signal}),e=>!e.started&&e.code==='CANCELLED');});
// The descendant outlives any scheduling delay, so the check cannot race its natural exit; draining is proven by the process disappearing, not by elapsed time.
test('successful leader exit with redirected surviving descendant is uncertain and drained',async t=>{const spec=await fixture(t);const marker=join(spec.cwd,'late-marker'),pidFile=join(spec.cwd,'descendant.pid');await assert.rejects(runProcess('/bin/sh',['-c',`(sleep 600; touch '${marker}') >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`],{env:subscriptionEnvironment(),timeoutMs:60000}),e=>e.started&&e.code==='DESCENDANTS_SURVIVE'&&!e.safeToRetry);const pid=Number(await readFile(pidFile,'utf8'));const live=()=>{try{return !/^\S+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`,'utf8'));}catch{return false;}};await until(()=>!live());await assert.rejects(readFile(marker));});
test('unsupported schema is refused before any CLI process',async t=>{const {adapter,calls}=fake('codex',codexEvents);await assert.rejects(adapter.invoke(await fixture(t,'codex',{schema:{type:'object',properties:{x:{pattern:'.*'}}}})),e=>e.code==='SCHEMA_UNSUPPORTED'&&!e.started);assert.equal(calls.length,0);});
test('resume must return the explicitly owned session',async t=>{const {adapter}=fake('codex',codexEvents.map(e=>e.type==='thread.started'?{...e,thread_id:'00000000-0000-0000-0000-000000000002'}:e));await assert.rejects(adapter.invoke(await fixture(t,'codex',{sessionId:session})),e=>e.code==='INVALID_RESULT'&&e.started);});

test('timeout retains bounded private partial output without serializing it into errors',async()=>{
  // A shell writes the partial output within milliseconds of starting, so the timeout fires after it even on a loaded host.
  await assert.rejects(runProcess('/bin/sh',['-c','echo private-output-sentinel; echo private-stderr-sentinel >&2; exec sleep 600'],{env:subscriptionEnvironment(),timeoutMs:2000,maxBytes:1024}),error=>{
    assert.equal(error.code,'TIMEOUT');assert.ok(error.stdout.includes('private-output-sentinel'));assert.ok(error.stderr.includes('private-stderr-sentinel'));assert.ok(!JSON.stringify(error).includes('sentinel'));assert.ok(!error.message.includes('sentinel'));return true;
  });
});

test('configured effort reaches both CLIs and model allowlist rejects before launch',async t=>{
  const codex=await fixture(t,'codex',{effort:'high',allowedModels:['test-model']});const first=fake('codex',codexEvents);await first.adapter.invoke(codex);assert.ok(first.calls.at(-1).args.includes('model_reasoning_effort="high"'));
  const claude=await fixture(t,'claude',{role:'auditor',effort:'high'});const second=fake('claude',claudeEvents,{help:help+' --effort'});await second.adapter.invoke(claude);assert.equal(second.calls.at(-1).args[second.calls.at(-1).args.indexOf('--effort')+1],'high');
  const blocked=fake('codex',codexEvents);await assert.rejects(blocked.adapter.invoke({...codex,allowedModels:['other']}),e=>e.code==='MODEL_NOT_ALLOWED'&&!e.started);assert.equal(blocked.calls.length,0);
});
test('safe configured fallback runs once before model start and preserves actual family evidence',async t=>{
  const calls=[];const transport=async(binary,args)=>{calls.push({binary,args});if(binary==='codex')throw new Error('not installed');if(args.includes('--version'))return{code:0,stdout:'2.1.323',stderr:''};if(args.includes('--help'))return{code:0,stdout:help,stderr:''};if(args.includes('status'))return{code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}),stderr:''};return{code:0,stdout:claudeEvents.map(e=>JSON.stringify(e)).join('\n'),stderr:''};};
  const adapter=createProviderAdapter({transport});const spec=await fixture(t,'codex',{role:'reviewer',allowFallback:true,fallback:{provider:'claude',model:'fallback-model',allowedModels:['fallback-model']}});const result=await adapter.invoke(spec);assert.equal(result.family,'anthropic');assert.equal(result.fallback.beforeModelStart,true);assert.equal(result.fallback.fromProvider,'codex');assert.equal(calls.filter(c=>c.args.includes('--json-schema')).length,1);
});
test('a legacy independence binding no longer refuses a same-family reviewer, and a resumed builder never changes provider',async t=>{
  const calls=[];const transport=async(binary,args)=>{calls.push({binary,args});throw new Error('unavailable');};const adapter=createProviderAdapter({transport});
  // Same-family review is allowed (readiness G8): the legacy fields are ignored, and only the real preflight failure remains.
  const base=await fixture(t,'codex',{role:'reviewer',independenceFamily:'openai',allowSameFamilyReview:false});await assert.rejects(adapter.invoke(base),e=>e.code==='PREFLIGHT_FAILED'&&!e.started);assert.ok(calls.length>0&&calls.every(c=>c.binary==='codex'));
  calls.length=0;await assert.rejects(adapter.invoke({...base,role:'builder',sessionId:session,allowFallback:true,fallback:{provider:'claude',model:'fallback-model'}}),e=>!e.started);assert.ok(calls.every(c=>c.binary==='codex'));
});
test('a model-started malformed result never uses configured fallback',async t=>{
  const {adapter,calls}=fake('codex','not-json');await assert.rejects(adapter.invoke(await fixture(t,'codex',{allowFallback:true,fallback:{provider:'claude',model:'fallback-model'}})),e=>e.code==='INVALID_RESULT'&&e.started);assert.ok(calls.every(c=>c.binary==='codex'));
});

test('a same-family reviewer launches its own primary; the configured fallback is not used to switch family',async t=>{const {adapter,calls}=fake('claude',claudeEvents);const spec=await fixture(t,'claude',{role:'reviewer',independenceFamily:'anthropic',allowFallback:true,fallback:{provider:'codex',model:'review-model'}});const result=await adapter.invoke(spec);assert.equal(result.family,'anthropic');assert.equal(result.fallback,undefined);assert.ok(calls.every(c=>c.binary==='claude'));});

test('usage survives invalid structured output without granting successful task evidence', async t => {
  const events = codexEvents.map(e => e.type === 'item.completed' ? { ...e, item: { type: 'agent_message', text: '{}' } } : e);
  const { adapter } = fake('codex', events);
  await assert.rejects(adapter.invoke(await fixture(t)), e => {
    assert.equal(e.code, 'INVALID_RESULT'); assert.equal(e.accountingResult.usageObservation.tokenSemantics, 'session-cumulative');
    assert.deepEqual(e.accountingResult.usage, codexEvents.at(-1).usage); return true;
  });
});
test('provider records unknown semantics for unqualified versions and preserves Claude delta metadata', async t => {
  const unknown = fake('codex', codexEvents, { version: 'codex-cli 0.999.0' });
  assert.equal((await unknown.adapter.invoke(await fixture(t))).usageObservation.tokenSemantics, 'unknown');
  const events = claudeEvents.map(e => e.type === 'result' ? { ...e, total_cost_usd: 7, model_usage_since_last_result: { fictional: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: .5 } } } : e);
  const { adapter } = fake('claude', events);
  const result = await adapter.invoke(await fixture(t, 'claude', { role: 'reviewer' }));
  assert.equal(result.usageObservation.tokenSemantics, 'invocation'); assert.equal(result.reportedCostUsd, 7);
  assert.equal(result.usageObservation.raw.modelUsageSinceLastResult.fictional.costUSD, .5);
});

test('failed fallback launch retains the effective provider for missing accounting coverage', async t => {
  const spec = await fixture(t, 'codex', { role: 'reviewer', allowFallback: true, fallback: { provider: 'claude', model: 'fallback-model' } });
  // Refuse the primary before launch; use the real adapter fallback path.
  const fallback = createProviderAdapter({ transport: async (binary, args, options) => {
    if (binary === 'codex') throw Error('unavailable');
    if (args.includes('--version')) return { code: 0, stdout: '2.1.323', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
    return { code: 1, stdout: 'not-json', stderr: '' };
  } });
  await assert.rejects(fallback.invoke(spec), error => { assert.equal(error.accountingResult.provider, 'claude'); assert.equal(error.accountingResult.model, 'fallback-model'); return true; });
});

test('a failed partial-trace write never replaces a started provider failure',async t=>{
  const spec=await fixture(t);
  const transport=async(binary,args)=>{if(args.includes('--version'))return{code:0,stdout:'codex-cli 0.169.0',stderr:''};if(args.includes('--help'))return{code:0,stdout:help,stderr:''};if(args.includes('status'))return{code:0,stdout:'Logged in using ChatGPT',stderr:''};
    await rm(spec.artifactDir,{recursive:true,force:true});const error=new ProviderError('Provider timed out',{started:true,code:'TIMEOUT'});error.stdout='partial';error.stderr='partial';throw error;};
  const guarded=createProviderAdapter({transport,environment:{HOME:'/fictional',PATH:'/bin'}});
  await assert.rejects(guarded.invoke(spec),e=>e instanceof ProviderError&&e.code==='TIMEOUT'&&e.started&&!e.safeToRetry&&e.accountingResult?.provider==='codex');
  const plain=async(binary,args)=>{if(!args.includes('-'))return transport(binary,args);await rm(spec.artifactDir,{recursive:true,force:true});throw Object.assign(new Error('transport broke'),{stdout:'partial'});};
  await assert.rejects(createProviderAdapter({transport:plain,environment:{HOME:'/fictional',PATH:'/bin'}}).invoke(spec),e=>e.code==='UNCERTAIN'&&e.started);
});

// dev.85: the generic process runner said "Provider timeout" whatever it ran, and a preflight
// failure did not say which CLI call failed or how.
test('dev.85: a stopped process is named by its label or executable, with how long it ran and its limit, never as a provider by default',async()=>{
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{env:subscriptionEnvironment(),timeoutMs:300,label:'factory CLI doctor'}),error=>{
    assert.equal(error.code,'TIMEOUT');assert.equal(error.message,'factory CLI doctor timed out after 0 s');assert.equal(error.timeoutMs,300);assert.ok(error.elapsedMs>=300);return true;});
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{env:subscriptionEnvironment(),timeoutMs:300}),error=>{assert.match(error.message,/^node timed out after 0 s$/);assert.doesNotMatch(error.message,/Provider/);return true;});
  await assert.rejects(runProcess('/nonexistent/fictional-binary',[],{env:subscriptionEnvironment()}),error=>{assert.equal(error.code,'ENOENT');assert.equal(error.message,'fictional-binary could not start (ENOENT)');return true;});
});
test('dev.85: a provider invocation that times out says it was the provider',async t=>{
  const spec=await fixture(t);
  const transport=async(binary,args,opts)=>{if(opts.input?.endsWith(spec.prompt)){assert.equal(opts.label,'codex provider');throw new ProviderError(`${opts.label} timed out after 60 s`,{started:true,code:'TIMEOUT'});}return {code:0,stdout:args.includes('--help')?help:args.includes('status')?'Logged in using ChatGPT':'codex-cli 0.169.0',stderr:''};};
  await assert.rejects(createProviderAdapter({transport}).invoke(spec),e=>e.code==='TIMEOUT'&&e.message==='codex provider timed out after 60 s');
});
test('dev.85: a preflight failure says which call failed and how: timeout, missing CLI, process error, invalid result or auth',async t=>{
  const spec=await fixture(t,'codex',{role:'reviewer',readOnly:true});
  const failing=(call,error)=>async(binary,args,opts)=>{const name=args.includes('--version')?'--version':args.includes('--help')?'--help':'auth status';assert.equal(opts.label,`codex ${name}`);assert.equal(opts.timeoutMs,15000);if(name===call){if(error instanceof Error)throw error;return error;}return {code:0,stdout:name==='--help'?help:name==='auth status'?'Logged in using ChatGPT':'codex-cli 0.169.0',stderr:''};};
  const timeout=call=>Object.defineProperty(new ProviderError(`codex ${call} timed out after 15 s`,{started:true,code:'TIMEOUT'}),'stderr',{value:'partial output'});
  await assert.rejects(createProviderAdapter({transport:failing('--help',timeout('--help'))}).preflight(spec),e=>e.code==='PREFLIGHT_FAILED'&&!e.started&&e.failure==='timeout'&&e.call==='--help'&&e.processCode==='TIMEOUT'&&e.message==='codex CLI preflight failed before model launch: codex --help timed out after 15 s'&&e.stderr==='partial output');
  // The auth call's output is never kept, on any path (review fix 1): only the kind and exit status.
  const authTimeout=Object.defineProperty(new ProviderError('codex auth status timed out after 15 s',{started:true,code:'TIMEOUT'}),'stderr',{value:'Account: person@example.invalid; home /home/person'});
  await assert.rejects(createProviderAdapter({transport:failing('auth status',authTimeout)}).preflight(spec),e=>e.failure==='timeout'&&e.call==='auth status'&&e.stderr===''&&e.message==='codex CLI preflight failed before model launch: codex auth status timed out after 15 s'&&!JSON.stringify({...e,message:e.message}).includes('person'));
  await assert.rejects(createProviderAdapter({transport:failing('auth status',{code:1,stdout:'Account: person@example.invalid',stderr:'home /home/person'})}).preflight(spec),e=>e.failure==='auth'&&e.stderr===''&&!e.message.includes('person'));
  await assert.rejects(createProviderAdapter({transport:failing('--version',new ProviderError('codex --version could not start (ENOENT)',{code:'ENOENT'}))}).preflight(spec),e=>e.code==='PREFLIGHT_FAILED'&&e.failure==='missing-cli'&&e.call==='--version'&&/could not be started \(ENOENT\)/.test(e.message));
  await assert.rejects(createProviderAdapter({transport:failing('--version',new ProviderError('codex --version left processes running after it exited',{started:true,code:'DESCENDANTS_SURVIVE'}))}).preflight(spec),e=>e.failure==='process-error'&&e.processCode==='DESCENDANTS_SURVIVE');
  await assert.rejects(createProviderAdapter({transport:failing('--version',{code:2,stdout:'',stderr:'fictional crash'})}).preflight(spec),e=>e.failure==='invalid-result'&&e.call==='--version'&&/exit code 2/.test(e.message)&&e.stderr==='fictional crash');
  await assert.rejects(createProviderAdapter({transport:failing('--help',{code:0,stdout:'--json',stderr:''})}).preflight(spec),e=>e.failure==='invalid-result'&&e.call==='--help'&&/lacks required.*missing --ignore-user-config/.test(e.message));
  await assert.rejects(createProviderAdapter({transport:failing('auth status',{code:1,stdout:'Logged in using API key fictional@example.invalid',stderr:''})}).preflight(spec),e=>e.code==='BILLING_UNVERIFIED'&&e.failure==='auth'&&e.call==='auth status'&&!e.stderr&&!e.message.includes('example.invalid'));
});
