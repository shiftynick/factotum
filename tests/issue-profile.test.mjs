import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, ForgeError } from '../starter/factory/adapters/github/index.mjs';
import { mapIssue } from '../starter/factory/adapters/github/issue-profile.mjs';
import { importGitHubTask } from '../starter/factory/workflows/commission.mjs';
import { sandbox } from './helpers.mjs';
const profile = { acceptanceHeadings:['Checked in the build'], postMergeHeadings:['Checked after merge, by whom'], pathsHeadings:['Files'], proseDependencies:true, ordinaryLabels:['ordinary'], strictLabels:['strict'], blockedLabels:['blocked','needs/operator'], forbiddenLabels:['kind/decision','kind/research','group'], importBlockedLabels:['in-progress','in-review'], areaPrefix:'area/', categoryPrefix:'kind/', followupLabels:['ordinary','backlog'], requireParent:true, requireArea:true, lifecycle:{labels:{admitted:'in-progress',review:'in-review',completed:'done',stopped:'parked'},approvalLabel:'approved'} };
const body = '## Checked in the build\n- A saved item survives reload\n- [ ] Empty input stays empty\n## Checked after merge, by whom\n- Operator checks hosted UI\n## Files\n- `src/item.js`\n\nDepends on #2 and #3';
const raw = () => ({id:10,number:1,title:'Save an item',state:'open',body,labels:['ordinary','approved','area/items']});
function transportFor(issue) { return async request => request.path === 'graphql' ? {data:{repository:{issue:{parent:{number:9}}}}} : structuredClone(issue); }
test('project issue profile maps prose acceptance, post-merge, dependencies, scope and parent without label approval', async () => {
  const forge = createGitHub({repository:'fictional/demo',issueProfile:profile,transport:transportFor(raw())});
  const task = await forge.readTask(1);
  assert.deepEqual(task.acceptance,['A saved item survives reload','Empty input stays empty']); assert.deepEqual(task.postMerge,['Operator checks hosted UI']); assert.deepEqual(task.dependencies,[2,3]); assert.deepEqual(task.paths,['src/item.js']); assert.equal(task.area,'items'); assert.equal(task.parent,9); assert.equal(task.risk,'ordinary'); assert.equal(task.approval,null); assert.deepEqual(task.followup,{parent:9,labels:['ordinary','backlog','area/items']});
});
test('structured briefs preserve scope and strict labels override ordinary brief; forbidden state and missing grouping block', () => {
  const issue = raw(); issue.body = '```factotum-task\n'+JSON.stringify({version:1,acceptance:['Outcome'],risk:'ordinary',paths:['src'],area:'items',category:'guidance',parent:4,dependencies:[7]})+'\n```'; issue.labels.push('strict','kind/decision');
  const mapped=mapIssue(issue,profile,4); assert.equal(mapped.risk,'strict'); assert.equal(mapped.category,'guidance'); assert.equal(mapped.blocked,true); assert.ok(mapped.blockedReasons.includes('kind/decision'));
  assert.equal(mapIssue({...raw(),labels:[]},profile).blocked,true);
});
test('factory-managed lifecycle labels do not invalidate approved source revision; all other content changes do',async()=>{
  let issue=raw(); const forge=createGitHub({repository:'fictional/demo',issueProfile:profile,transport:async request=>request.path==='graphql'?{data:{repository:{issue:{parent:{number:9}}}}}:issue});
  const first=await forge.readTask(1); issue={...issue,labels:['ordinary','area/items','in-progress']}; const managed=await forge.readTask(1); assert.equal(first.revision,managed.revision);
  issue={...issue,labels:[...issue.labels,'needs/operator']}; assert.notEqual((await forge.readTask(1)).revision,first.revision);
});
test('issue import preserves grouping and scope but remains canonically unapproved',async t=>{
  const f=sandbox(t); f.store.setMeta('config',{repository:{slug:'fictional/demo',issueProfile:profile}});
  const imported=await importGitHubTask(f.stateDir,1,{transport:transportFor(raw())});
  assert.equal(imported.area,'items'); assert.deepEqual(imported.paths,['src/item.js']); assert.equal(imported.parent,9); assert.equal(imported.approvedRevision,null); assert.deepEqual(imported.dependencies,['github:2','github:3']);
  const held=raw(); held.labels.push('in-progress'); await assert.rejects(importGitHubTask(f.stateDir,1,{transport:transportFor(held)}),/already in progress/);
});
test('lifecycle reconciles labels after ambiguous comment publication and never repeats the publication',async()=>{
  const issue=raw(),comments=[];let posts=0;
  const transport=async request=>{
    if(request.path==='graphql')return {data:{repository:{issue:{parent:{number:9}}}}};
    if(request.path.includes('/comments?'))return comments;
    if(request.path.endsWith('/comments')){posts++;comments.push({id:4,body:request.body.body});throw new ForgeError('lost',{ambiguous:true});}
    if(request.path.endsWith('/labels')&&request.method==='POST'){issue.labels.push(...request.body.labels);return issue.labels;}
    if(request.method==='DELETE'){issue.labels=issue.labels.filter(l=>l!==decodeURIComponent(request.path.split('/').at(-1)));return null;}
    return issue;
  };
  const forge=createGitHub({repository:'fictional/demo',issueProfile:profile,transport}),revision=(await forge.readTask(1)).revision;
  await forge.publishLifecycle({issue:1,phase:'admitted',operationId:'flow:admit',expectedRevision:revision}); await forge.publishLifecycle({issue:1,phase:'admitted',operationId:'flow:admit',expectedRevision:revision}); assert.equal(posts,1);assert.ok(issue.labels.includes('in-progress'));
  await forge.publishLifecycle({issue:1,phase:'completed',operationId:'flow:complete',expectedRevision:revision});assert.ok(issue.labels.includes('done'));assert.ok(!issue.labels.includes('approved'));assert.ok(!issue.labels.includes('in-progress'));
});
test('followup publication recovers one issue, preserves parent and area, links PR, and refuses approval',async()=>{
  const issues=[],comments=[];let posts=0,parent=null;
  const forge=createGitHub({repository:'fictional/demo',issueProfile:profile,transport:async r=>{
    if(r.path==='graphql')return {data:{repository:{issue:{parent:parent?{number:parent}:null}}}};
    if(r.path.includes('issues?'))return issues;
    if(r.path.includes('/comments?'))return comments;
    if(r.path.endsWith('/comments')){comments.push({id:8,body:r.body.body});return comments.at(-1);}
    if(r.path.endsWith('/sub_issues')){parent=9;assert.equal(r.body.sub_issue_id,10);return{};}
    if(r.method==='POST'){posts++;issues.push({id:10,number:2,html_url:'https://example.invalid/2',body:r.body.body});throw new ForgeError('lost',{ambiguous:true});}
  }});
  const input={flowId:'flow',reviewDigest:'abc',task:{title:'Save item',followup:{parent:9,labels:['ordinary','backlog','area/items']}},findings:[{severity:'medium',file:'src/a.js',line:2,message:'Unused helper'}],prNumber:3};
  assert.equal((await forge.createFollowup(input)).number,2);assert.equal((await forge.createFollowup(input)).number,2);assert.equal(posts,1);assert.equal(comments.length,1);assert.equal(parent,9);
  await assert.rejects(forge.createFollowup({...input,task:{title:'Unsafe',followup:{labels:['approved']}}}),/cannot grant approval/);
});
test('open PR mapping fails closed on incomplete reference pagination',async()=>{
  const forge=createGitHub({repository:'fictional/demo',issueProfile:{rejectOpenPR:true},transport:async r=>r.path==='graphql'?{data:{repository:{pullRequests:{nodes:[{closingIssuesReferences:{nodes:[],pageInfo:{hasNextPage:true}}}],pageInfo:{hasNextPage:false}}}}}:raw()});
  await assert.rejects(forge.readTask(1),/references incomplete/);
});

test('reviewed plan updates one canonical issue comment and reconciles a lost update response',async()=>{const comments=[];let creates=0,updates=0;const forge=createGitHub({repository:'fictional/demo',transport:async r=>{if(r.path.includes('/comments?'))return comments;if(r.method==='POST'){creates++;comments.push({id:7,body:r.body.body});return comments[0];}if(r.method==='PATCH'){updates++;comments[0].body=r.body.body;throw new ForgeError('lost',{ambiguous:true});}}});const first={issue:1,taskRevision:'v1',operationId:'plan:first',body:'First reviewed plan'};await forge.publishReviewedPlan(first);const revised={...first,operationId:'plan:refresh',body:'Refreshed reviewed plan'};const result=await forge.publishReviewedPlan(revised);assert.equal(result.reconciled,true);await forge.publishReviewedPlan(revised);assert.equal(creates,1);assert.equal(updates,1);assert.equal(comments.length,1);assert.match(comments[0].body,/Refreshed/);});

test('managed lifecycle labels cannot hide forbidden, blocked or risk classification semantics',()=>{for(const label of ['blocked','kind/decision','ordinary','strict'])assert.throws(()=>mapIssue(raw(),{...profile,lifecycle:{...profile.lifecycle,labels:{...profile.lifecycle.labels,admitted:label}}},9),/cannot also block, forbid, or classify risk/);assert.throws(()=>mapIssue(raw(),{...profile,lifecycle:{...profile.lifecycle,approvalLabel:'strict'}},9),/cannot also block, forbid, or classify risk/);});

test('a follow-up is created importable, and a tracked issue can be promoted to a task', async () => {
  const posted = [], patched = [], labelled = [];
  const forge = createGitHub({ repository: 'fictional/demo', issueProfile: profile, transport: async r => {
    if (r.path.includes('issues?') || r.path.includes('/comments?')) return [];
    if (r.path === 'graphql') return { data: { repository: { issue: { parent: null } } } };
    const path = r.path.replace(/^repos\/fictional\/demo\//, '');
    if (path === 'issues' && r.method === 'POST') { posted.push(r.body); return { id: 11, number: 5, html_url: 'https://example.invalid/5' }; }
    if (r.path.endsWith('/comments')) return { id: 1 };
    if (r.path.endsWith('/sub_issues')) return {};
    if (path === 'issues/7' && r.method === 'PATCH') { patched.push(r.body.body); return {}; }
    if (path === 'issues/7/labels') { labelled.push(...r.body.labels); return []; }
    if (path === 'issues/7') return { number: 7, state: 'open', title: 'Write the FAQ', body: 'Some notes.', labels: [{ name: 'operator' }] };
    return {};
  } });
  await forge.createFollowup({ flowId: 'flow', reviewDigest: 'd', task: { title: 'Save item' }, findings: [{ severity: 'low', file: 'src/a.js', line: 2, message: 'Unused helper' }], prNumber: 3, eligibilityLabels: ['factory'] });
  assert.ok(posted[0].labels.includes('factory'));
  const mapped = mapIssue({ number: 5, title: 'Review follow-up: Save item', body: posted[0].body, labels: posted[0].labels.map(name => ({ name })), state: 'open' }, profile);
  assert.deepEqual(mapped.paths, ['src/a.js']); assert.equal(mapped.risk, 'ordinary'); assert.match(mapped.acceptance[0], /Unused helper/);
  // A follow-up selects its parent's workflow and target: it carries the parent's selecting labels and named workflow.
  await forge.createFollowup({ flowId: 'flow-web', reviewDigest: 'e', task: { title: 'Web item', labels: ['web', 'factory'], workflow: 'web' }, findings: [{ severity: 'low', file: 'src/b.js', line: 1, message: 'Rename' }], prNumber: 4, eligibilityLabels: ['factory'], selectionLabels: ['web'], workflow: 'web' });
  const web = posted.at(-1);
  assert.ok(web.labels.includes('web') && web.labels.includes('factory'));
  assert.equal(mapIssue({ number: 6, title: 'Review follow-up: Web item', body: web.body, labels: web.labels.map(name => ({ name })), state: 'open' }, profile).workflow, 'web');
  const promoted = await forge.promoteTask({ issue: 7, labels: ['factory'], brief: { version: 1, outcome: 'Write the FAQ', acceptance: ['The FAQ page exists'] } });
  assert.deepEqual(promoted, { issue: 7, briefAdded: true, labelsAdded: ['factory'] });
  assert.match(patched[0], /^Some notes\.\n\n```factotum-task\n/); assert.deepEqual(labelled, ['factory']);
});

test('re-running finds a failed job even when its run concluded success (continue-on-error)', async () => {
  let rerun = false; const posts = [];
  const forge = createGitHub({ repository: 'fictional/demo', issueProfile: profile, transport: async r => {
    const path = r.path.replace(/^repos\/fictional\/demo\//, '');
    if (path.startsWith('actions/runs?')) return { workflow_runs: [{ id: 7, name: 'Verify', event: 'pull_request', status: 'completed', conclusion: 'success' }, { id: 9, name: 'Lint', event: 'pull_request', status: 'completed', conclusion: 'success' }] };
    if (path === 'actions/runs/7/jobs?per_page=100') return { jobs: [{ name: 'Security gate', conclusion: rerun ? 'success' : 'failure' }] };
    if (path === 'actions/runs/9/jobs?per_page=100') return { jobs: [{ name: 'lint', conclusion: 'success' }] };
    if (path === 'actions/runs/7/rerun') { posts.push(path); rerun = true; return {}; }
    if (path === 'actions/runs/7') return { name: 'Verify', status: 'completed', conclusion: 'success' };
    return {};
  } });
  const head = 'a'.repeat(40), runs = await forge.rerunFailedRuns({ head });
  assert.deepEqual(runs, [{ id: 7, name: 'Verify', jobs: ['Security gate'] }]); assert.deepEqual(posts, ['actions/runs/7/rerun']);
  assert.deepEqual(await forge.workflowRuns({ ids: [7] }), [{ id: 7, name: 'Verify', status: 'completed', conclusion: 'success' }]);
  rerun = false;
  assert.equal((await forge.workflowRuns({ ids: [7] }))[0].conclusion, 'failure', 'a still-failing job fails the run');
});
