// Must-fix review, slice 5 (docs/designs/review-must-fix.md 12.3): the console evidence of a must-fix
// flow. Its merge question shows the must-fix counts in place of severity counts, the purpose
// assessment and every finding that was not fixed; it is answered with one check box per finding,
// and the page sends the claim digests it shows; a changed finding makes the project refuse it. The
// flow page has the review ledger; the findings page shows review rows; the state view and Stats
// carry the new fields, bounded. The question is a real one, opened by the engine for a fixture flow
// (review-must-fix-decision-fixtures.mjs); a flow pinned to `must-fix` exists only in fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, withText } from './fake-dom.mjs';
import { decisionFlow, changeResult, finding, fileCite } from './review-must-fix-decision-fixtures.mjs';
import { publicFlow } from '../starter/factory/core/project.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { mergeQuestionContext } from '../starter/factory/operations/merge-context.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

installDom();
const { state } = await import('../starter/factory/console/ui/state.mjs');
const { inboxView, mergeCandidateView } = await import('../starter/factory/console/ui/inbox.mjs');
const { reviewLedgerCard } = await import('../starter/factory/console/ui/timeline.mjs');
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const text = node => node.textContent;
const noImpact = message => ({ ...finding(message, 'none', 'shown', [fileCite()]), severity: 'medium' });
const project = (snapshot = {}) => ({ projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
  revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], findings: [], ...snapshot,
  settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } });
const inputs = node => byTag(node, 'input').filter(input => (input.type ?? input.getAttribute('type')) === 'checkbox');
const submitForm = async form => { for (const handler of form.handlers.submit ?? []) await handler({ preventDefault() {} }); };

async function strictQuestion(t) {
  const f = await decisionFlow(t, { risk: 'strict', review: { strictFollowups: true } });
  await f.build();
  await f.review([changeResult({ verdict: 'revise', strict: true, findings: [noImpact('The reader logs at debug level'), { ...finding('A record split across two reads may be read twice', 'outcome', 'unknown'), severity: 'high' }] })]);
  await f.effect(); await f.gate();
  return { f, item: await f.question() };
}

test('the merge question of a must-fix flow: counts, purpose and findings in place of severity counts; one check box per finding; the page sends the claim digests it shows', async t => {
  const { f, item } = await strictQuestion(t);
  const flow = publicFlow(f.current()), p = project({ flows: [flow], inbox: [{ ...item, mergeContext: mergeQuestionContext(f.current()) }], tasks: [f.store.need('task', 'task-1')] });
  state.projects = [p]; state.unresolved = new Set(); state.journal = [];
  t.after(() => { state.projects = []; state.journal = []; });
  const view = inboxView(p, { params: {} }), shown = text(view);
  assert.match(shown, /Review findings/);
  assert.match(shown, /0 must-fix open, 1 operator item, 1 follow-up, 0 deferrals/, 'must-fix counts');
  assert.doesNotMatch(text(mergeCandidateView(p, p.snapshot.inbox[0])), /0 critical, /, 'no severity counts for a must-fix flow');
  assert.match(text(mergeCandidateView(p, p.snapshot.inbox[0])), /1 operator item, 1 follow-up/);
  assert.match(shown, /outcome and every criterion met; no silent wrong answer/, 'the purpose assessment');
  // The list of 11.5: operator items first, with scenario, class, reachability and citation validation.
  const items = withText(view, 'li', /^R1\.\d/);
  assert.deepEqual(items.map(li => li.textContent.slice(0, 4)), ['R1.2', 'R1.1']);
  assert.match(items[0].textContent, /Operator item \(unresolved-scenario\)/);
  assert.match(items[1].textContent, /class none · reachability shown · citations validated/);
  assert.match(shown, /“Validated” means the cited text, fact or record exists as cited, not that it supports the claim/);
  // One check box per finding, labelled with the claim digest it sends.
  const boxes = inputs(view);
  assert.equal(boxes.length, 2);
  for (const row of item.strictReview.acknowledgements) assert.match(text(view), new RegExp(row.claimDigest.slice(0, 16)), `${row.id}'s claim is shown`);
  assert.equal(withText(view, 'button', 'Authorize merge').length, 1, 'the strict answer is the acknowledgement form');
  const form = byTag(view, 'form').find(node => /Acknowledge and authorize the merge/.test(node.textContent));
  let sent = null; const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async (_path, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ projectId: 'fictional', commandId: sent.commandId, status: 'completed', receipt: { status: 'completed' } }) }; };
  // Not every box checked: nothing is sent.
  boxes[0].checked = true; await submitForm(form);
  assert.equal(sent, null, 'an unchecked finding sends nothing');
  boxes[1].checked = true; await submitForm(form);
  assert.equal(sent.operation, 'answer');
  assert.deepEqual(sent.payload.acknowledgedFindings, item.strictReview.acknowledgements.map(row => ({ id: row.id, claimDigest: row.claimDigest })), 'the digests the page shows');
  assert.equal(sent.payload.reviewedHead, item.strictReview.head);
  // The project accepts exactly that payload.
  const answered = f.send('answer', sent.payload);
  assert.equal(answered.status, 'completed', answered.error);
});

test('a changed finding makes the project refuse the page\'s answer, and the reopened question shows the change', async t => {
  const { f, item } = await strictQuestion(t);
  const p = project({ flows: [publicFlow(f.current())], inbox: [item] });
  state.projects = [p]; t.after(() => { state.projects = []; state.journal = []; });
  const boxes = inputs(inboxView(p, { params: {} }));
  assert.equal(boxes.length, 2);
  const payload = { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'merge', reviewedHead: item.strictReview.head, acknowledgedFindings: item.strictReview.acknowledgements.map(row => ({ id: row.id, claimDigest: row.claimDigest })) };
  // The operator accepts the operator item meanwhile: the list changes.
  const entry = f.ledger().entries.find(row => row.id === 'R1.2');
  assert.equal(f.send('flow.disposeFinding', { flowId: 'flow-1', findingId: 'R1.2', disposition: 'operator-accepted', note: 'Accepted as a fictional follow-up.', expectedVersion: entry.version }).status, 'completed');
  const refused = f.send('answer', payload);
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /stale or resolved question|question subject changed/);
  const reopened = await f.question();
  const view = inboxView(project({ flows: [publicFlow(f.current())], inbox: [reopened] }), { params: {} });
  assert.match(text(view), /R1\.2 · Follow-up \(unresolved-scenario\)/, 'the refreshed page shows the change');
  assert.match(text(view), /operator: operator-accepted/);
});

test('the flow page has the review ledger; the findings page shows review rows; the state view and Stats carry the new fields, bounded', async t => {
  const { f, item } = await strictQuestion(t);
  assert.equal((await f.answer('merge', { reviewedHead: repositoryIdentity(f.root).head, acknowledgedFindings: item.strictReview.acknowledgements.map(row => ({ id: row.id, claimDigest: row.claimDigest })) })).status, 'completed');
  const flow = publicFlow(f.current());
  const ledger = reviewLedgerCard(flow);
  assert.match(text(ledger), /Review ledger \(2\)/);
  assert.deepEqual(byTag(ledger, 'tr').slice(1).map(row => row.children[0].textContent), ['R1.1', 'R1.2'], 'one row per finding');
  assert.equal(reviewLedgerCard({ ...flow, reviewBar: 'shadow' }), null, 'only a must-fix flow');
  // Findings page: the review rows beside audit findings, with who may act on them.
  const findings = f.store.all('finding'), p = project({ flows: [flow], findings, tasks: [f.store.need('task', 'task-1')] });
  state.projects = [p]; t.after(() => { state.projects = []; });
  const ops = text(operationsView(p));
  assert.match(ops, /Review finding/); assert.match(ops, /R1\.2 · operator-item \(unresolved-scenario\)/); assert.match(ops, /The operator only/);
  // The state view: the flow's must-fix fields, and the restriction once one is set (after the merge here:
  // a restriction before it would refuse the answer and reopen the question).
  f.publishPR(); await f.effect(); await f.finish();
  assert.equal(f.send('review.restrict', { protectedClassDeferral: false, expectedVersion: 0, note: 'Fictional protected-class escape.' }).status, 'completed');
  const view = stateView(f.store, { flow: 'flow-1' });
  assert.deepEqual(view.flow.mustFix.ledger.entries.map(row => [row.id, row.kind]), [['R1.1', 'follow-up'], ['R1.2', 'operator-item']]);
  assert.deepEqual(view.flow.mustFix.decision.acknowledged, ['R1.2', 'R1.1']);
  assert.deepEqual([view.project.reviewRestriction.version, view.project.reviewRestriction.protectedClassDeferral], [1, false]);
  // Stats: the must-fix measures, only when a must-fix flow finished in the window.
  const stats = projectStats(f.store, { window: '7d' });
  const ids = stats.quality.map(row => row.id);
  for (const id of ['mustfix-parked', 'mustfix-operator-items', 'mustfix-follow-ups', 'mustfix-deferrals', 'mustfix-acknowledgements', 'mustfix-overrides', 'mustfix-late']) assert.ok(ids.includes(id), id);
  assert.equal(stats.quality.find(row => row.id === 'mustfix-acknowledgements').headline, 2);
});

test('a severity flow\'s state view and stats carry nothing of the must-fix bar', async t => {
  const f = await decisionFlow(t, { bar: 'severity' });
  const view = stateView(f.store, { flow: 'flow-1' });
  assert.equal(view.flow.mustFix, undefined); assert.equal(view.project.reviewRestriction, undefined);
  assert.equal(projectStats(f.store, { window: '7d' }).quality.some(row => row.id.startsWith('mustfix-')), false);
});
