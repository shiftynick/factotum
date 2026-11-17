import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

test('CLI --help and -h print usage without state or command side effects',()=>{
 for(const [args,expected] of [[['--help'],/Commands:.*adopt install/],[['-h'],/Commands:.*adopt install/],[['adopt','--help'],/Usage: adopt status[\s\S]*adopt install --root/],[['adopt','install','-h'],/Usage: adopt install --root[\s\S]*--digest/]]){const result=spawnSync(process.execPath,[join(process.cwd(),'starter/factory/cli.mjs'),...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,expected);assert.doesNotMatch(result.stderr,/ERR_PARSE_ARGS_UNKNOWN_OPTION/);}
});
test('overview attention uses readable standalone notice titles and keeps question text',async()=>{
 const previous=Object.fromEntries(['document','localStorage','sessionStorage'].map(k=>[k,globalThis[k]]));globalThis.document={querySelector:()=>({content:'fictional-csrf'})};globalThis.localStorage=globalThis.sessionStorage={getItem:()=>null};
 try {const {attention}=await import('../starter/factory/console/ui/overview.mjs');const rows=attention({projectId:'fictional',status:'available',snapshot:{inbox:[{id:'issue-3',kind:'notice',status:'open',title:'A useful notice title',context:'Full notice detail'},{id:'question-1',kind:'question',role:'operator',status:'open',title:'Scheduling',question:'Which schedule?'}]}});assert.equal(rows[0].detail,'A useful notice title');assert.equal(rows[1].detail,'Which schedule?');assert.match(rows[0].action.href,/item=issue-3/);}
 finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
