import {quietGitHubEnvironment} from './environment.mjs';
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS } from '../../core/git-options.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from '../providers/index.mjs';
const scope = new AsyncLocalStorage();
const assert = (ok,message) => { if(!ok)throw new Error(message); };
const keep = ['HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','GH_CONFIG_DIR'];
const clean = env => ({...Object.fromEntries(keep.filter(k=>env[k]).map(k=>[k,env[k]])),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',SSH_ASKPASS:'/bin/false'});
export {clean as scopedGitEnvironment};
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function approvedURL(value, state) {
  let url;
  try {
    if(/^git@[^:]+:/.test(value)) {const [host,...parts]=value.slice(4).split(':');url=new URL(`https://${host}/${parts.join(':')}`);}
    else {url=new URL(value);if(url.protocol==='ssh:'&&url.username==='git'&&!url.password)url=new URL(`https://${url.hostname}${url.pathname}`);}
  }catch {throw new Error('Git remote must identify the configured GitHub repository');}
  assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash,'Git remote credentials or alternate transport are forbidden');
  assert(url.hostname.toLowerCase()===state.host && url.pathname.replace(/^\//,'').replace(/\.git$/i,'').toLowerCase()===state.slug.toLowerCase(),'Git remote does not match configured host and repository');
  return state.url;
}
/** Token exists only in this asynchronous scope and Git subprocess environment. */
export async function withGitHubGitScope(repository, fn, {transport=runProcess,environment=process.env}={}) {
  const host=(repository.hostname??'github.com').toLowerCase(),slug=repository.slug;
  assert(/^[a-z\d.-]+$/.test(host)&&/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(slug??'')&&typeof repository.account==='string'&&repository.account&&!repository.account.startsWith('-'),'Explicit GitHub host, repository and account required');
  const inherited=scope.getStore();if(inherited){assert(inherited.host===host&&inherited.slug===slug&&inherited.account===repository.account,'Nested GitHub account or repository scope conflict');return fn();}
  const env=quietGitHubEnvironment(clean(environment));
  const ghPath=repository.ghPath??'gh',auth=await transport(ghPath,['auth','token','--hostname',host,'--user',repository.account],{env,timeoutMs:15000});
  const token=auth.stdout?.trim();assert(auth.code===0&&token&&!/\s/.test(token),'Configured GitHub account credential unavailable');
  const state={host,slug,ghPath,account:repository.account,remote:repository.remote??'origin',url:`https://${host}/${slug}.git`,token,transport,environment};
  assert(/^[a-z\d_.-]+$/i.test(state.remote),'Invalid configured Git remote');
  return scope.run(state,fn);
}
export function hasGitHubGitScope(){return Boolean(scope.getStore());}
// The scoped GitHub token, only so callers can keep it out of what they write to disk.
export function scopedGitHubToken(){return scope.getStore()?.token;}
// The commissioned gh binary for calls made inside a repository scope.
export function scopedGhPath(){return scope.getStore()?.ghPath;}
export async function prepareGitInvocation(args,{cwd,env=process.env}={}) {
  // Planted commands (fsmonitor, hooks, signing programs) do not run in Factotum's own Git calls, in
  // rehearsal as in delivery: builder worktrees share the Git config they would come from.
  const options=[...NO_AUTO_MAINTENANCE,...NO_PLANTED_COMMANDS,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','tag.gpgSign=false'];
  const state=scope.getStore();if(!state)return {args:[...options,...args],env};
  const base=clean(env),network=['fetch','push','ls-remote'].includes(args[0]);
  if(!network)return {args:[...options,...args],env:base};
  // Repository-local transport customizations must not defeat explicit account/endpoint selection.
  const config=await state.transport('git',['config','--local','--includes','--null','--list'],{cwd,env:base,timeoutMs:10000});
  assert(config.code===0,'Cannot inspect repository Git configuration');
  const entries=config.stdout.split('\0').filter(Boolean).map(line=>{const p=line.indexOf('\n');return [line.slice(0,p).toLowerCase(),line.slice(p+1)];});
  assert(!entries.some(([key])=>/^(url\.|http\.|https\.|credential\.|core\.(sshcommand|gitproxy)|remote\.[^.]+\.(proxy|uploadpack|receivepack|vcs)$)/i.test(key)),'Repository transport overrides must be removed before account-pinned Git operations');
  let remoteIndex=1;while(remoteIndex<args.length&&args[remoteIndex].startsWith('-'))remoteIndex++;
  assert(remoteIndex<args.length,'Explicit approved Git remote required');
  const value=args[remoteIndex];let remoteURL=value;
  if(value===state.remote) {
    const urls=entries.filter(([key])=>key===`remote.${state.remote.toLowerCase()}.url`).map(([,v])=>v);
    const pushurls=entries.filter(([key])=>key===`remote.${state.remote.toLowerCase()}.pushurl`).map(([,v])=>v);
    assert(urls.length===1 && (pushurls.length===0||pushurls.length===1),'Exactly one approved Git remote URL required');
    for(const url of [...urls,...pushurls])approvedURL(url,state);remoteURL=urls[0];
  }
  approvedURL(remoteURL,state);
  const rewritten=[...args];rewritten[remoteIndex]=state.url;
  // Fetch by URL does not update named-remote tracking refs unless its refspec is explicit.
  if(args[0]==='fetch'&&value===state.remote)for(let i=remoteIndex+1;i<rewritten.length;i++)if(!rewritten[i].includes(':')&&!rewritten[i].startsWith('-')) {const branch=rewritten[i].replace(/^refs\/heads\//,'');assert(/^[a-z\d_./-]+$/i.test(branch)&&!branch.includes('..'),'Invalid fetch branch');rewritten[i]=`refs/heads/${branch}:refs/remotes/${state.remote}/${branch}`;}
  const helper=`!${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} credential-helper`;
  options.push('-c','credential.helper=','-c',`credential.helper=${helper}`,'-c','credential.useHttpPath=true','-c','http.extraHeader=','-c','http.followRedirects=false','-c','http.sslVerify=true','-c','http.proxy=','-c','protocol.allow=never','-c','protocol.https.allow=always');
  return {args:[...options,...rewritten],env:{...base,FACTOTUM_GIT_TOKEN:state.token,FACTOTUM_GIT_HOST:state.host,FACTOTUM_GIT_REPOSITORY:state.slug}};
}
export function credentialResponse(input,environment=process.env) {
  const fields=Object.fromEntries(input.split('\n').filter(Boolean).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
  if(fields.protocol!=='https'||fields.host?.toLowerCase()!==environment.FACTOTUM_GIT_HOST||fields.path?.replace(/\.git$/i,'').toLowerCase()!==environment.FACTOTUM_GIT_REPOSITORY?.toLowerCase()||!environment.FACTOTUM_GIT_TOKEN)return '';
  return `username=x-access-token\npassword=${environment.FACTOTUM_GIT_TOKEN}\n\n`;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url&&process.argv[2]==='credential-helper') {
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>65536)process.exit(1);}
  if(process.argv[3]==='get')process.stdout.write(credentialResponse(input));
}
