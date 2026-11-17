import {runProcess} from '../providers/index.mjs';
import {quietGitHubEnvironment} from './environment.mjs';
import {scopedGhPath} from './git.mjs';
import { createHash } from 'node:crypto';
import { mapIssue, validateIssueProfile, dependencyNumber } from './issue-profile.mjs';
import { ForgeError, cliFailureDetails, reconcileWriteFailure } from './errors.mjs';
export { ForgeError } from './errors.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const segment = value => encodeURIComponent(String(value));
const number = value => { assert(Number.isSafeInteger(Number(value)) && Number(value) > 0, 'positive issue/PR number required'); return Number(value); };

// GitHub can close issues when PR descriptions or commit messages reach the default
// branch. The reference closes its approved source issue through a separate action.
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+(?:#\d+|[a-z\d_.-]+\/[a-z\d_.-]+#\d+|https?:\/\/[^\s)]+\/issues\/\d+|\[[^\]]*\]\(https?:\/\/[^)]+\/issues\/\d+)/i;
// The closing reference a text carries (for example "Fixes #11"), or null. One rule for PR
// prose, merge messages and candidate commits, at merge and when a pull request is adopted.
export function closingReference(text) {
  if (typeof text !== 'string') return null;
  const match = CLOSING_REFERENCE.exec(text);
  return match ? match[0].replace(/\s+/g, ' ') : null;
}
export function assertNoClosingReferences(...texts) {
  assert(texts.every(text => !closingReference(text)), 'GitHub closing references require explicit task disposition; use plain task references');
}

export function cleanGitHubEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_DEBUG']) delete env[key];
  return quietGitHubEnvironment(env);
}

export async function runGh(args, { env=process.env, input, timeoutMs = 60_000, ghPath } = {}) {
  let result;
  try { result=await runProcess(ghPath??scopedGhPath()??'gh',args,{env:quietGitHubEnvironment(env),input,timeoutMs}); }
  catch(error) { throw new ForgeError(`GitHub CLI could not complete with owned subprocesses quiescent (${error.code ?? 'unknown'})`,{kind:'transport',ambiguous:error.started!==false,cause:error,diagnostics:cliFailureDetails(error,env)}); }
  if(result.code===0)return result.stdout;
  const status=Number(result.stderr.match(/HTTP (\d{3})/)?.[1])||undefined;
  const kind=/rate limit/i.test(result.stderr)||status===429?'rate-limit':status===401||status===403?'authorization':status===404?'not-found':'transport';
  // The message remains a summary; bounded, redacted stderr is separate evidence.
  throw new ForgeError(`GitHub operation failed (${kind}${status?` HTTP ${status}`:''})`,{status,kind,ambiguous:!status||status>=500,diagnostics:cliFailureDetails(result,env)});
}

export function createGhTransport({ account, hostname = 'github.com', run = runGh, ghPath }) {
  assert(typeof account === 'string' && /^[a-z\d][a-z\d-]*$/i.test(account), 'explicit GitHub account required');
  assert(/^[a-z\d.-]+$/i.test(hostname), 'invalid GitHub hostname');
  return async ({ method = 'GET', path, body }) => {
    const env = cleanGitHubEnvironment();
    const token = (await run(['auth', 'token', '--hostname', hostname, '--user', account], { env, ghPath })).trim();
    assert(token && !/\s/.test(token), 'GitHub credential lookup failed');
    const credentialEnv = { ...env, GH_HOST: hostname, [hostname === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']: token };
    const args = ['api', '--hostname', hostname, '--method', method, path, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const text = await run(args, { env: credentialEnv, ghPath, input: body === undefined ? undefined : JSON.stringify(body) });
    return text.trim() ? JSON.parse(text) : null;
  };
}

export function createGitHub({ repository, account, hostname = 'github.com', transport, qualification, issueProfile = {}, ghPath } = {}) {
  assert(/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repository || ''), 'repository must be owner/name');
  validateIssueProfile(issueProfile);
  const request = transport || createGhTransport({ account, hostname, ghPath });
  const root = `repos/${repository}`;
  const api = (path, method = 'GET', body) => request({ path: `${root}/${path}`, method, body });
  const marker = operationId => { assert(typeof operationId === 'string' && operationId.length > 0, 'operationId required'); return `<!-- factotum:${digest(operationId)} -->`; };
  const pages = async path => { const rows = []; for (let page = 1; page <= 1000; page++) { const part = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`); assert(Array.isArray(part), 'invalid paginated response'); rows.push(...part); if (part.length < 100) return rows; } throw new ForgeError('publication lookup exceeded page limit', { kind: 'incomplete' }); };
  // The factory's own GitHub identity is the configured account: every call uses its token.
  const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const factoryAuthored = row => sameName(row?.user?.login, account) && sameName(row?.head?.repo?.full_name, repository);
  const lookupPublication = async ({ issue, branch, operationId }) => {
    const rows = issue ? await pages(`issues/${number(issue)}/comments`) : await pages(`pulls?state=all&head=${segment(`${repository.split('/')[0]}:${branch}`)}`);
    const matches = rows.filter(row => row.body?.includes(marker(operationId)));
    assert(matches.length <= 1, 'multiple external publications for operation');
    return matches[0] || null;
  };
  const writeOnce = async (identity, payload, write) => {
    const payloadMarker = `<!-- factotum-input:${digest(payload)} -->`;
    const validate = row => { assert(row.body?.includes(payloadMarker), 'operationId reused with different publication input'); return { ...row, reconciled: true }; };
    const existing = await lookupPublication(identity); if (existing) return validate(existing);
    try { return await write(payloadMarker); } catch (error) {
      if (!error.ambiguous) throw error;
      return reconcileWriteFailure(error, 'Write outcome uncertain; reconcile before another dispatch', async () => { const recovered = await lookupPublication(identity); return recovered ? validate(recovered) : null; });
    }
  };
  const dependencyLimit=issueProfile.maxDependencies??32;
  const readDependency = async issue => {
    const id=number(issue),raw=await api(`issues/${id}`);assert(!raw.pull_request&&raw.number===id&&['open','closed'].includes(raw.state),'dependency must be the requested readable issue');
    const identity={repository,issue:id,state:raw.state,title:raw.title??'',body:raw.body??'',labels:(raw.labels??[]).map(l=>typeof l==='string'?l:l.name).sort()};
    // contentRevision is the issue's text alone: an edit to it, unlike its progress, needs dependents approved again.
    return {repository,issue:id,state:raw.state,revision:digest(identity),contentRevision:digest({repository,issue:id,title:identity.title,body:identity.body}),observedAt:new Date().toISOString(),provenance:'github-issue-state',...(raw.html_url?{url:raw.html_url}:{})};
  };
  const verifyDependencies = async ({issue,dependencies=[],declaredDependencies}) => {
    assert(Array.isArray(dependencies)&&dependencies.length<=dependencyLimit,'remote dependency limit exceeded');
    const declared=declaredDependencies??(await readTask(issue)).dependencies;
    assert(Array.isArray(declared)&&declared.length<=dependencyLimit,'declared remote dependency limit exceeded');
    const required=[...new Set(declared.map(d=>dependencyNumber(d,issueProfile)).filter(d=>d!==null))];
    assert(required.every(d=>Number.isSafeInteger(d)&&d>0&&d!==number(issue)),'invalid declared remote dependency');
    assert(required.length===dependencies.length&&required.every(d=>dependencies.some(f=>f.issue===d)),'remote dependency facts do not cover declared prerequisites; reimport task');
    const seen=new Set(),evidence=[];
    for(const fact of dependencies){assert(fact&&fact.repository===repository&&fact.provenance==='github-issue-state'&&fact.taskId===`${issueProfile.dependencyIdPrefix??'github:'}${fact.issue}`&&fact.issue!==number(issue)&&Number.isSafeInteger(fact.issue)&&fact.issue>0&&!seen.has(fact.issue),'invalid remote dependency identity');seen.add(fact.issue);const current=await readDependency(fact.issue);assert(current.state==='closed',`remote dependency is not closed: #${fact.issue}`);evidence.push({...current,taskId:fact.taskId});}
    return evidence;
  };
  const readTask = async issue => {
    const raw = await api(`issues/${number(issue)}`); assert(!raw.pull_request, 'issue is a pull request');
    let parent = null;
    if (issueProfile.requireParent || issueProfile.readParent) {
      const [owner, name] = repository.split('/');
      const graph = await request({ path: 'graphql', method: 'POST', body: { query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number}}}}', variables: { owner, name, number: number(issue) } } });
      assert(!graph.errors && graph.data?.repository?.issue, 'issue parent lookup incomplete');
      parent = graph.data.repository.issue.parent?.number ?? null;
    }
    const mapped = mapIssue(raw, issueProfile, parent);
    if (issueProfile.rejectOpenPR === true) {
      const [owner, name] = repository.split('/'); let cursor = null, complete = false;
      for (let page = 0; page < 1000 && !complete; page++) {
        const graph = await request({path:'graphql',method:'POST',body:{query:'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN,after:$cursor){pageInfo{hasNextPage endCursor} nodes{closingIssuesReferences(first:100){nodes{number} pageInfo{hasNextPage}}}}}}',variables:{owner,name,cursor}}});
        const prs = graph.data?.repository?.pullRequests;
        assert(!graph.errors && Array.isArray(prs?.nodes) && prs.pageInfo, 'open PR lookup incomplete');
        assert(prs.nodes.every(pr => !pr.closingIssuesReferences?.pageInfo?.hasNextPage && Array.isArray(pr.closingIssuesReferences?.nodes)), 'open PR issue references incomplete');
        if (prs.nodes.some(pr => pr.closingIssuesReferences.nodes.some(ref => ref.number === number(issue)))) { mapped.blocked = true; mapped.blockedReasons.push('open pull request already claims issue'); }
        complete = !prs.pageInfo.hasNextPage; cursor = prs.pageInfo.endCursor;
        assert(complete || cursor, 'open PR pagination cursor missing');
      }
      assert(complete, 'open PR lookup exceeded page limit');
    }
    const { labels, revisionLabels, ...content } = mapped;
    const snapshot = { ...content, labels: revisionLabels };
    return { id: `${repository}#${number(issue)}`, number: number(issue), repository, state: raw.state, revision: digest(snapshot), ...content, labels, updatedAt: raw.updated_at, url: raw.html_url, approval: null };
  };
  const publishComment = ({ issue, operationId, body }) => writeOnce({ issue, operationId }, { issue, body }, inputMarker => api(`issues/${number(issue)}/comments`, 'POST', { body: `${body}\n\n${marker(operationId)}\n${inputMarker}` }));
  const publishReviewedPlan = async ({ issue, taskRevision, operationId, body }) => {
    assert(taskRevision && operationId && typeof body === 'string', 'reviewed plan identity required');
    const identity = `plan:issue:${number(issue)}`, ownMarker = marker(identity), inputMarker = `<!-- factotum-input:${digest({taskRevision,operationId,body})} -->`;
    const desired = `${body}\n\n${ownMarker}\n${inputMarker}`;
    const lookup = () => lookupPublication({issue,operationId:identity});
    let existing = await lookup();
    if (existing?.body === desired) return {...existing,reconciled:true};
    try { return existing ? await api(`issues/comments/${number(existing.id)}`, 'PATCH', {body:desired}) : await api(`issues/${number(issue)}/comments`, 'POST', {body:desired}); }
    catch (error) { if (!error.ambiguous) throw error; return reconcileWriteFailure(error, 'Plan publication outcome uncertain; reconcile same plan before dispatch', async () => { const found = await lookup(); return found?.body === desired ? { ...found, reconciled: true } : null; }); }
  };
  const publishLifecycle = async ({ issue, phase, operationId, expectedRevision, body }) => {
    const lifecycle = issueProfile.lifecycle;
    if (!lifecycle) return { skipped: true, reason: 'lifecycle profile disabled' };
    assert(['admitted','review','completed','stopped'].includes(phase), 'invalid lifecycle phase');
    const current = await readTask(issue);
    assert(expectedRevision && current.revision === expectedRevision, 'source task changed before lifecycle publication');
    const comment = await publishComment({ issue, operationId, body: body ?? `Factory lifecycle: ${phase}.` });
    const desired = lifecycle.labels[phase], managed = [...new Set(Object.values(lifecycle.labels))];
    if (desired && !current.labels.includes(desired)) await api(`issues/${number(issue)}/labels`, 'POST', { labels: [desired] });
    for (const label of managed.filter(label => label !== desired && current.labels.includes(label))) {
      try { await api(`issues/${number(issue)}/labels/${segment(label)}`, 'DELETE'); } catch (error) { if (error.status !== 404) throw error; }
    }
    if (phase === 'completed' && lifecycle.approvalLabel && current.labels.includes(lifecycle.approvalLabel)) {
      try { await api(`issues/${number(issue)}/labels/${segment(lifecycle.approvalLabel)}`, 'DELETE'); } catch (error) { if (error.status !== 404) throw error; }
    }
    return { phase, commentId: comment.id, labels: desired ? [desired] : [], sourceRevision: current.revision };
  };
  // Create a source task: an issue with a factotum-task brief, written at most once per operationId.
  const createTask = async ({ operationId, title, brief, labels = [] }) => {
    assert(operationId && title && brief?.version === 1, 'task creation needs an operation, title and brief');
    const operationMarker = marker(operationId), body = `${brief.outcome ?? title}\n\n\`\`\`factotum-task\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n${operationMarker}`;
    const lookup = async () => { const matches = (await pages('issues?state=all')).filter(row => !row.pull_request && row.body?.includes(operationMarker)); assert(matches.length <= 1, 'multiple issues for one creation'); return matches[0] ?? null; };
    let issue = await lookup();
    if (!issue) {
      try { issue = await api('issues', 'POST', { title, body, labels: [...new Set(labels)] }); }
      catch (error) { if (!error.ambiguous) throw error; issue = await reconcileWriteFailure(error, 'Issue creation outcome uncertain; reconcile before retrying', lookup); }
    } else issue = { ...issue, reconciled: true };
    return { number: issue.number, url: issue.html_url ?? issue.url, reconciled: issue.reconciled === true };
  };
  // A brief the factory imports: approving the issue's task is then one step.
  const briefBlock = brief => `\`\`\`factotum-task\n${JSON.stringify(brief, null, 2)}\n\`\`\``;
  const promoteTask = async ({ issue, labels = [], brief }) => {
    assert(brief?.version === 1 && Array.isArray(brief.acceptance) && brief.acceptance.length, 'a brief with acceptance is required');
    const raw = await api(`issues/${number(issue)}`); assert(!raw.pull_request && raw.state === 'open', 'an open issue is required');
    const body = raw.body ?? '';
    const next = /```factotum-task\s*\n/.test(body) ? body : `${body.trimEnd()}\n\n${briefBlock(brief)}\n`;
    if (next !== body) await api(`issues/${number(issue)}`, 'PATCH', { body: next });
    const missing = labels.filter(l => !(raw.labels ?? []).some(x => (typeof x === 'string' ? x : x.name) === l));
    if (missing.length) await api(`issues/${number(issue)}/labels`, 'POST', { labels: missing });
    return { issue: number(issue), briefAdded: next !== body, labelsAdded: missing };
  };
  const createFollowup = async ({ flowId, reviewDigest, task, findings, prNumber, eligibilityLabels = [], selectionLabels = [], workflow }) => {
    assert(flowId && reviewDigest && task?.title && Array.isArray(findings) && findings.length, 'followup evidence required');
    const operationId = `followup:${flowId}:${reviewDigest}`, operationMarker = marker(operationId);
    // Created importable: the source's eligibility labels and a drafted brief. It is still unapproved.
    const labels = [...new Set([...(task.followup?.labels ?? issueProfile.followupLabels ?? []), ...eligibilityLabels, ...selectionLabels])];
    assert(labels.every(l => typeof l === 'string' && l.length && !['approved',issueProfile.lifecycle?.approvalLabel].includes(l)), 'followup cannot grant approval');
    const parent = task.followup?.parent ?? task.parent ?? null;
    const title = `Review follow-up: ${task.title}`;
    const paths = [...new Set(findings.map(f => f.file).filter(f => typeof f === 'string' && f && !f.startsWith('/')))].slice(0, 32);
    const brief = { version: 1, outcome: `Resolve the remaining review findings for ${task.title}`, acceptance: findings.slice(0, 20).map(f => `Fixed, or dismissed with a reason: [${f.severity}] ${f.file}:${f.line} ${f.message}`.slice(0, 500)), ...(paths.length ? { paths } : {}), ...(typeof workflow === 'string' && workflow ? { workflow } : {}), risk: 'ordinary' };
    const body = `Remaining review findings for ${task.title}:\n\n${findings.map(f => `- [${f.severity}] ${f.file}:${f.line}: ${f.message}`).join('\n')}\n\nDrafted brief; edit it before approving if needed. This issue is unapproved.\n\n${briefBlock(brief)}\n${operationMarker}`;
    const inputMarker = `<!-- factotum-input:${digest({ title, body, labels, parent })} -->`;
    const lookup = async () => { const matches = (await pages('issues?state=all')).filter(row => !row.pull_request && row.body?.includes(operationMarker)); assert(matches.length <= 1, 'multiple followup issues for operation'); if (matches[0]) assert(matches[0].body.includes(inputMarker), 'followup operation reused with changed input'); return matches[0]; };
    let issue = await lookup();
    if (!issue) {
      try { issue = await api('issues', 'POST', { title, body: `${body}\n${inputMarker}`, labels }); }
      catch (error) { if (!error.ambiguous) throw error; issue = await reconcileWriteFailure(error, 'Followup outcome uncertain; reconcile before dispatch', lookup); }
    }
    // Parent linkage uses the child database ID and is idempotently reconciled.
    if (parent) {
      const [owner, name] = repository.split('/');
      const graph = await request({ path:'graphql', method:'POST', body:{ query:'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number}}}}', variables:{owner,name,number:issue.number} } });
      assert(!graph.errors && graph.data?.repository?.issue, 'followup parent lookup incomplete');
      const existing = graph.data.repository.issue.parent?.number;
      assert(!existing || existing === parent, 'followup has a different parent');
      if (!existing) { assert(Number.isSafeInteger(issue.id), 'followup database ID missing'); await api(`issues/${number(parent)}/sub_issues`, 'POST', { sub_issue_id:issue.id }); }
    }
    if (prNumber) await publishComment({ issue:prNumber, operationId:`${operationId}:pr`, body:`Remaining non-blocking review findings are tracked in #${issue.number}.` });
    return { number:issue.number, url:issue.html_url ?? issue.url, operationId, approved:false, parent };
  };
  const readPR = async id => {
    const raw = await api(`pulls/${number(id)}`);
    return { number: raw.number, repository, state: raw.state, head: raw.head.sha, headBranch: raw.head.ref, headRef: raw.head.ref, base: raw.base.sha, baseBranch: raw.base.ref, baseRef: raw.base.ref, merged: raw.merged === true, mergeCommit: raw.merge_commit_sha, headRepository: typeof raw.head.repo?.full_name === 'string' ? raw.head.repo.full_name : null, mergeable: raw.mergeable, mergeableState: typeof raw.mergeable_state === 'string' ? raw.mergeable_state : null, draft: raw.draft, commits: raw.commits, url: raw.html_url, title: raw.title || '', body: raw.body || '', author: typeof raw.user?.login === 'string' ? raw.user.login : null };
  };
  // An open PR's commits, oldest first, complete or refused: the commits endpoint lists at most 250.
  // Merge validation and PR adoption read them through this one bound.
  const readPRCommits = async (id, { expectedHead, expectedCount }) => {
    assert(Number.isSafeInteger(expectedCount) && expectedCount > 0 && expectedCount <= 250, 'PR commit-message closure validation requires 1-250 commits');
    const commits = await pages(`pulls/${number(id)}/commits`);
    assert(commits.length === expectedCount && commits.at(-1)?.sha === expectedHead && commits.every(commit => typeof commit.commit?.message === 'string'), 'incomplete PR commit-message validation');
    return commits.map(commit => ({ sha: commit.sha, message: commit.commit.message }));
  };
  const inspectProtection = async ({ branch, requiredContext }) => {
    let raw;
    try { raw = await api(`branches/${segment(branch)}/protection`); } catch (error) { if (error.status === 404) return { targetFreshness: 'local-only', reason: 'protection unavailable' }; throw error; }
    const checks = raw.required_status_checks;
    const contexts = [...(checks?.contexts || []), ...(checks?.checks || []).map(check => check.context)];
    const enforced = checks?.strict === true && raw.enforce_admins?.enabled === true && !!requiredContext && contexts.includes(requiredContext);
    return { targetFreshness: enforced ? 'strict-status' : 'local-only', enforced, requiredContext, branch };
  };
  // A definite refusal of the merge because the pull request's branch does not contain the base
  // branch's head: branch protection that requires an up-to-date branch, or the base moving while
  // the merge was made. It is told apart from other refusals (a missing review, a failed check)
  // by the refusal's own text or, failing that, by the pull request's state read again
  // (`mergeable_state: behind`). The caller re-integrates; nothing was merged.
  const OUT_OF_DATE = /out[- ]of[- ]date|not up[- ]to[- ]date|must be up[- ]to[- ]date|base branch was modified|branch is behind/i;
  const outOfDateRefusal = async (error, id, expectedHead, baseBranch) => {
    if (!(error instanceof ForgeError) || error.ambiguous || ![405, 409, 422].includes(error.status)) return null;
    let behind = OUT_OF_DATE.test(`${error.message}\n${error.diagnostics?.stderr ?? ''}`);
    if (!behind) { try { const after = await readPR(id); behind = !after.merged && after.head === expectedHead && after.mergeableState === 'behind'; } catch { behind = false; } }
    return behind ? new ForgeError(`GitHub refused the merge: the pull request's branch is out of date with ${baseBranch ?? 'its base branch'} (HTTP ${error.status}); integrate the base branch again`, { status: error.status, kind: 'out-of-date', cause: error, diagnostics: error.diagnostics }) : null;
  };
  return {
    readTask, readDependency, verifyDependencies, readPR, readPRCommits, lookupPublication, createTask, promoteTask, inspectProtection, publishLifecycle, createFollowup, publishComment, publishReviewedPlan,
    publishPlan: publishComment,
    // A pull request found by the publication lookup (an earlier attempt's, or one whose response was
    // lost) is adopted only if the factory's own GitHub identity (the configured account, whose token
    // every call uses) opened it from the configured repository. The markers alone prove nothing:
    // they are reproducible hashes, so anyone could open a pull request on the branch that carries
    // them (review of e73ae9e, P2-1). Every publication records who opened the pull request and how.
    createPR: ({ branch, base, title, body, operationId }) => { assertNoClosingReferences(title, body); return writeOnce({ branch, operationId }, { branch, base, title, body }, inputMarker => api('pulls', 'POST', { head: branch, base, title, body: `${body}\n\n${marker(operationId)}\n${inputMarker}` })).then(row => {
      if (row?.reconciled) {
        if (!factoryAuthored(row)) throw new ForgeError(`pull request #${row.number} on branch ${branch} carries the factory's publication markers but was not opened by the factory's GitHub identity (${account ?? 'not configured'}) from ${repository}; it is not adopted. Close it and publish again`, { kind: 'not-factory-authored' });
        return { ...row, factoryAuthor: { login: row.user.login, headRepository: row.head.repo.full_name, how: 'reconciled' } };
      }
      return { ...row, factoryAuthor: { login: typeof row?.user?.login === 'string' ? row.user.login : account ?? null, headRepository: typeof row?.head?.repo?.full_name === 'string' ? row.head.repo.full_name : repository, how: 'created' } };
    }); },
    // Re-run the head's pull-request workflow runs that have a failed job (a required check that
    // read the commit's statuses before Factotum posted its own). A job marked continue-on-error
    // fails while its run still concludes success, so jobs are inspected, not run conclusions.
    rerunFailedRuns: async ({ head }) => {
      assert(/^[a-f\d]{40,64}$/i.test(head), 'invalid head');
      const runs = ((await api(`actions/runs?head_sha=${head}&per_page=100`)).workflow_runs ?? []).filter(run => run.event === 'pull_request' && run.status === 'completed');
      const failed = [];
      for (const run of runs) {
        const jobs = (await api(`actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? [];
        const bad = jobs.filter(job => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion));
        if (bad.length || ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion)) failed.push({ id: run.id, name: run.name, jobs: bad.map(job => job.name) });
      }
      for (const run of failed) await api(`actions/runs/${run.id}/rerun`, 'POST', {});
      return failed;
    },
    // A rerun is done when the run is completed; it passed only if none of its jobs failed.
    workflowRuns: async ({ ids }) => Promise.all(ids.map(async id => {
      const run = await api(`actions/runs/${id}`);
      if (run.status !== 'completed') return { id, name: run.name, status: run.status, conclusion: null };
      const jobs = (await api(`actions/runs/${id}/jobs?per_page=100`)).jobs ?? [], bad = jobs.filter(job => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion));
      return { id, name: run.name, status: 'completed', conclusion: bad.length ? 'failure' : run.conclusion ?? null, ...(bad.length ? { failedJobs: bad.map(job => job.name) } : {}) };
    })),
    publishCheck: ({ head, context, state, description, targetUrl }) => { assert(/^[a-f\d]{40,64}$/i.test(head), 'invalid head'); assert(['error', 'failure', 'pending', 'success'].includes(state), 'invalid check state'); return api(`statuses/${head}`, 'POST', { context, state, description, ...(targetUrl ? { target_url: targetUrl } : {}) }); },
    // Close a pull request the factory published for a knowledge-upkeep follow-up it ended
    // (operations/upkeep-pr-close.mjs). Only that pull request, and only as the factory recorded it
    // when it created it: its number, its author (the factory's own identity, which must also be the
    // configured account now) and its head repository (the configured one), its head and branch, and
    // the factory's creation marker for that flow in its body. Anything else, or a merged one, is
    // refused without a write, as `{ refused }` (review of e73ae9e, P2-1).
    //
    // Before any write the pull request's timeline is read: once the factory has closed it, it never
    // closes it again. One that is open again after a close by the factory was reopened by someone,
    // and that is settled as `{ reopened }` for the operator, with nothing written (P2-2). The comment
    // is written once (its own marker), and the state is read again just before the close, so a
    // person's close or reopen in between is respected. An ambiguous close is reconciled by reading
    // the pull request again.
    closeFollowUpPR: async ({ number: id, expectedHead, expectedBranch, expectedAuthor, expectedRepository, creationOperationId, operationId, body }) => {
      const read = async () => {
        const pr = await readPR(id);
        if (!pr.body.includes(marker(creationOperationId))) return { refused: `pull request #${id} is not the one the factory published for this follow-up` };
        if (!sameName(pr.author, expectedAuthor) || !sameName(pr.author, account)) return { refused: `pull request #${id} was opened by ${pr.author ?? 'an unknown author'}, not by the factory's GitHub identity (${account ?? 'not configured'}) that published it` };
        if (!sameName(pr.headRepository, expectedRepository) || !sameName(pr.headRepository, repository)) return { refused: `pull request #${id} comes from ${pr.headRepository ?? 'an unknown repository'}, not from ${repository}` };
        if (pr.merged) return { refused: `pull request #${id} is merged` };
        const events = await pages(`issues/${number(id)}/events`);
        const ours = events.filter(row => row?.event === 'closed' && sameName(row.actor?.login, account)), last = ours.at(-1);
        if (pr.state === 'closed') return { closed: true, already: true, number: pr.number };
        if (last) { const reopenedBy = events.slice(events.indexOf(last) + 1).find(row => row?.event === 'reopened')?.actor?.login ?? 'someone'; return { reopened: `pull request #${id} was closed by the factory and reopened by ${reopenedBy}; the factory does not close it again` }; }
        if (pr.head !== expectedHead || pr.headRef !== expectedBranch) return { refused: `pull request #${id} has moved since the factory published it (head ${String(pr.head).slice(0, 12)} on ${pr.headRef})` };
        return { open: pr };
      };
      const before = await read(); if (!before.open) return before;
      const comment = await publishComment({ issue: id, operationId, body });
      const now = await read(); if (!now.open) return now;
      try { await api(`pulls/${number(id)}`, 'PATCH', { state: 'closed' }); }
      catch (error) {
        if (!error.ambiguous) throw error;
        return reconcileWriteFailure(error, 'Close outcome uncertain; reconcile the pull request', async () => { const after = await readPR(id); return after.state === 'closed' ? { closed: true, number: after.number, reconciled: true } : null; });
      }
      return { closed: true, number: before.open.number, commentId: comment?.id ?? null };
    },
    merge: async ({ number: id, expectedHead, expectedBase, mode = 'manual', mergeMethod = 'merge', requiredContext, commitTitle, commitMessage }) => {
      assert(['manual', 'auto'].includes(mode), 'invalid merge mode');
      assert(['merge','squash','rebase'].includes(mergeMethod),'invalid merge method');
      assert(expectedHead && expectedBase, 'expected head and base required');
      const pr = await readPR(id);
      if (pr.merged) { assert(pr.head === expectedHead, 'merged PR head differs'); return { merged: true, sha: pr.mergeCommit, expectedHead, expectedBase, reconciled: true }; }
      assert(pr.state === 'open' && !pr.draft, 'PR is not mergeable open work');
      assert(pr.head === expectedHead && pr.base === expectedBase, 'candidate or target changed');
      assertNoClosingReferences(pr.title, pr.body, commitTitle, commitMessage);
      const commits = await readPRCommits(id, { expectedHead, expectedCount: pr.commits });
      assertNoClosingReferences(...commits.map(commit => commit.message));
      const protection = await inspectProtection({ branch: pr.baseBranch, requiredContext });
      if (mode === 'auto') assert(protection.enforced && qualification?.qualified === true && qualification?.targetFreshness === 'strict-status', 'automatic merge lacks qualified remote target enforcement');
      try {
        const result = await api(`pulls/${number(id)}/merge`, 'PUT', { sha: expectedHead, merge_method: mergeMethod, ...(mergeMethod !== 'rebase' && commitTitle ? { commit_title: commitTitle } : {}), ...(mergeMethod !== 'rebase' && commitMessage ? { commit_message: commitMessage } : {}) });
        assert(result.merged === true, 'forge did not merge candidate');
        return { ...result, expectedHead, expectedBase, targetFreshness: protection.targetFreshness, residualTargetRace: !protection.enforced };
      } catch (error) {
        if (!error.ambiguous) throw await outOfDateRefusal(error, id, expectedHead, pr.baseBranch) ?? error;
        return reconcileWriteFailure(error, 'Merge outcome uncertain; reconcile the existing PR', async () => { const after = await readPR(id); return after.merged && after.head === expectedHead ? { merged: true, sha: after.mergeCommit, expectedHead, expectedBase, reconciled: true } : null; });
      }
    },
  };
}
