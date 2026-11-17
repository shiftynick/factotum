import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
// The provider's working directory sits beside the private artifact folder, never around it.
const workIn = async directory => { const work = join(directory, 'work'); await mkdir(work, { recursive: true }); return work; };
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderAdapter, BUILD_SCHEMA, REVIEW_SCHEMA } from '../starter/factory/adapters/providers/index.mjs';

const recordings=fileURLToPath(new URL('../evals/recordings/',import.meta.url));
const provenance=JSON.parse(await readFile(join(recordings,'provenance.json'),'utf8'));
const help='--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
function replayTransport(capture,stream) {
  // Deliberate test doubles: these preflight replies do not come from the recording
  // and establish no live authentication, isolation, billing or tool capability.
  return async (binary,args)=>{
    assert.equal(binary,capture.provider);
    if(args.includes('--version'))return{code:0,stdout:capture.cliVersion,stderr:''};
    if(args.includes('--help'))return{code:0,stdout:help,stderr:''};
    if(args.includes('status'))return{code:0,stdout:capture.provider==='codex'?'Logged in using ChatGPT':JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}),stderr:''};
    return{code:0,stdout:stream,stderr:''};
  };
}
for(const capture of provenance.captures) {
  test(`${capture.provider} observed projected protocol decodes into a complete role-valid receipt`,async t=>{
    const directory=await mkdtemp(join(tmpdir(),'factotum-recording-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const stream=await readFile(join(recordings,capture.file),'utf8');assert.equal(createHash('sha256').update(stream).digest('hex'),capture.sha256);
    const events=stream.trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.length,capture.events);
    const expected=capture.provider==='codex'?JSON.parse(events.find(event=>event.type==='item.completed').item.text):events.find(event=>event.type==='result').structured_output;
    const expectedSession=capture.provider==='codex'?events[0].thread_id:events[0].session_id;
    const adapter=createProviderAdapter({transport:replayTransport(capture,stream),environment:{}});
    const receipt=await adapter.invoke({provider:capture.provider,model:capture.requestedModel,role:capture.role,prompt:'Replay only the recorded fictional protocol projection.',cwd:await workIn(directory),artifactDir:join(directory,'artifacts'),timeoutMs:60000,schema:capture.role==='builder'?BUILD_SCHEMA:REVIEW_SCHEMA});
    assert.equal(receipt.final,true);assert.equal(receipt.started,true);assert.equal(receipt.sessionId,expectedSession);assert.deepEqual(receipt.result,expected);
    assert.deepEqual(receipt.usage,capture.provider==='codex'?events.find(event=>event.type==='turn.completed').usage:events.find(event=>event.type==='result').usage);
    assert.equal(receipt.provider,capture.provider);assert.equal(receipt.billing.mode,'subscription');
    assert.deepEqual(JSON.parse(await readFile(join(directory,'artifacts','result.json'),'utf8')),receipt);
  });
}

test('observed recording projections omit private/tool material and retain only normalized sessions',async()=>{
  const allowedSessions=new Set(['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']);
  for(const capture of provenance.captures) {
    const text=await readFile(join(recordings,capture.file),'utf8');
    assert(!/\/home\/|\/tmp\/|https?:\/\/|factotum-live-|(?:gh[pousr]_|sk-)[a-z\d]{8}/i.test(text),'Private paths, URLs or credential-shaped strings are forbidden');
    for(const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi))assert(allowedSessions.has(match[0]));
    for(const event of text.trim().split('\n').map(line=>JSON.parse(line))) {
      assert(['thread.started','item.completed','turn.completed','system','result'].includes(event.type));
      if(event.type==='item.completed')assert.equal(event.item.type,'agent_message');
      for(const key of ['cwd','original_cwd','tools','mcp_servers','prompt','command','tool_input','tool_output','account','repository','uuid'])assert(!Object.hasOwn(event,key));
    }
  }
});

test('observed final projections still require the provider completion boundary',async t=>{
  const capture=provenance.captures.find(item=>item.provider==='codex');
  const stream=(await readFile(join(recordings,capture.file),'utf8')).trim().split('\n').filter(line=>JSON.parse(line).type!=='turn.completed').join('\n');
  const directory=await mkdtemp(join(tmpdir(),'factotum-incomplete-recording-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const adapter=createProviderAdapter({transport:replayTransport(capture,stream),environment:{}});
  await assert.rejects(adapter.invoke({provider:'codex',model:capture.requestedModel,role:'builder',prompt:'Incomplete recorded projection.',cwd:await workIn(directory),artifactDir:join(directory,'artifacts'),timeoutMs:60000}),error=>error.code==='INVALID_RESULT'&&error.started&&!error.safeToRetry);
});
