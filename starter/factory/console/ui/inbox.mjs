import { timeNode, relativeTimeNode } from './admission.mjs';
import { h, chip, card, kv, empty, notice, time, relative, link, short, raw, segmented, flowName, localizeTimes, forgeBase, forgeUrl, forgePull, forgeCommit, forgeCompare, safeUrl, externalLink } from './dom.mjs';
import { state, href, available, uiState, saveUi, findProject, flowTitle, detailHref, openObligation, read } from './state.mjs';
import { commandButton, commandForm } from './actions.mjs';
// The review schema's severities (adapters/providers REVIEW_SCHEMA), in order.
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
// The files page of an already validated pull request URL: /files is added to the path, and any
// query or fragment is dropped (appending to the whole URL would land inside them).
export function pullRequestFiles(url) { const parsed = new URL(url); parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/files`; parsed.search = ''; parsed.hash = ''; return parsed.href; }

// Full-screen viewer for preview images: arrow keys move between them, Escape or a click closes.
function openViewer(project, preview, images, start) {
  let index = start;
  const img = h('img', { alt: '' }), caption = h('p', { class: 'viewer-caption' });
  const dialog = h('dialog', { class: 'image-viewer', 'aria-label': 'Preview image' }, img, caption);
  const show = () => { const f = images[index], data = read(project, 'previews', preview.attemptId, { name: f.name }).data; img.src = data?.dataUrl ?? ''; img.alt = `Preview ${f.name}`; caption.textContent = `${f.name} · ${index + 1} of ${images.length}${images.length > 1 ? ' · ← → to move, Esc to close' : ' · Esc to close'}`; };
  dialog.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { index = (index + 1) % images.length; show(); } if (e.key === 'ArrowLeft') { index = (index - 1 + images.length) % images.length; show(); } });
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); show(); dialog.showModal();
}
// Screenshots the workflow's preview step took of this exact candidate.
function previewCard(project, preview) {
  const images = preview.files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)), other = preview.files.filter(f => !images.includes(f));
  const rerender = () => window.dispatchEvent(new Event('factotum:render'));
  return card('Preview of this candidate', h('div', { class: 'stack' },
    preview.route === 'fail' ? notice('warning', 'The preview command failed.', preview.reason ?? '') : null,
    images.length ? h('div', { class: 'preview-grid' }, images.map((f, i) => { const entry = read(project, 'previews', preview.attemptId, { name: f.name }, { onDone: rerender }); return h('figure', {}, entry.data?.dataUrl ? h('button', { type: 'button', class: 'preview-thumb', 'aria-label': `View ${f.name} full screen`, on: { click: () => openViewer(project, preview, images, i) } }, h('img', { src: entry.data.dataUrl, alt: `Preview ${f.name}`, loading: 'lazy' })) : h('div', { class: 'skeleton', text: entry.status === 'error' ? `Unavailable: ${entry.error}` : 'Loading…' }), h('figcaption', { class: 'muted small', text: f.name })); })) : h('p', { class: 'muted', text: 'The preview produced no images.' }),
    other.length ? h('p', { class: 'muted small', text: `Also produced (kept with the attempt's evidence, not shown here): ${other.map(f => f.name).join(', ')}` }) : null));
}
// Links to the exact candidate: its commit and, when published, its pull request's changes.
function candidateLinks(project, item, flow) {
  const repo = project.snapshot.settings?.repository, head = item.strictReview?.head, publish = flow?.results?.publish;
  const pr = forgePull(repo, publish?.number) ?? forgeUrl(repo, publish?.url), commit = forgeCommit(repo, head);
  return h('p', {}, 'Candidate ', h('code', { text: String(head).slice(0, 12) }), commit ? [' · ', link(commit, 'Commit')] : null, pr ? [' · ', link(pullRequestFiles(pr), 'Pull request changes')] : null);
}
// What a merge question is about (service: operations/merge-context.mjs): the pull request, the
// candidate commit, the review verdict and the checks on that candidate, and a link to the diff.
// Anything the project adds to the question (item.context) is shown above it unchanged.
const ROUTE_STATUS = { pass: 'passed', fail: 'failed', blocked: 'blocked', held: 'held', revise: 'revise', defer: 'passed', delta: 'passed' };
function checkSummary(r, empty) {
  if (!r) return h('span', { class: 'muted', text: empty });
  const failed = r.checks.filter(c => c.status !== 'passed'), passed = r.checks.filter(c => c.status === 'passed');
  return h('span', {}, chip(ROUTE_STATUS[r.route] ?? r.route ?? 'unknown', ROUTE_STATUS[r.route] ?? r.route ?? 'not recorded'),
    ` ${r.checks.length ? `${passed.length} of ${r.checks.length} passed` : 'no checks listed'}${failed.length ? ` · not passed: ${failed.map(c => `${c.id} (${c.status})`).join(', ')}` : passed.length ? `: ${passed.map(c => c.id).join(', ')}` : ''}`,
    r.current ? null : h('span', { class: 'warn-text', text: ` · recorded for ${r.head ? `commit ${r.head.slice(0, 12)}` : 'another commit'}, not this candidate` }));
}
export function mergeCandidateView(project, item) {
  const m = item.mergeContext;
  if (!m) return null;
  // Links are built from the configured repository; a recorded URL is used only when it is on that forge.
  const repo = project.snapshot.settings?.repository, host = repo?.hostname ?? 'github.com', forge = forgeBase(repo);
  const prUrl = forgePull(repo, m.pullRequest?.number) ?? forgeUrl(repo, m.pullRequest?.url);
  const diffUrl = prUrl ? pullRequestFiles(prUrl) : forgeCompare(repo, m.base, m.candidate);
  const commitUrl = forgeCommit(repo, m.candidate);
  // Every review severity is counted, zero included ("0 critical, 0 high, 0 medium, 0 low"), then any other recorded one.
  const review = m.review, counts = review?.bySeverity ?? {}, severities = review ? [...SEVERITIES, ...Object.keys(counts).filter(k => !SEVERITIES.includes(k))].map(k => `${counts[k] ?? 0} ${k}`).join(', ') : '';
  // External PR adoption: the original pull request and what the project last observed of it
  // (item.originalPR); commits pushed there after adoption are not in this candidate.
  const o = item.originalPR, adopted = m.adoptedFrom ?? (o?.number ? { number: o.number } : null);
  const originalUrl = forgePull(repo, adopted?.number) ?? forgeUrl(repo, o?.url);
  const checkedNote = o?.checkedAt ? [' (checked ', timeNode(o.checkedAt), ')'] : [];
  const originalState = !o ? 'not checked before this question' : [o.status === 'unchanged' ? 'unchanged since adoption' : o.status === 'moved' ? `changed after adoption: head now ${String(o.head ?? '').slice(0, 12)}${o.rewritten ? ', history rewritten' : ''}` : `could not be checked${o.error ? ` (${o.error})` : ''}`, ...checkedNote];
  const undelivered = o?.status === 'moved' ? (o.commits === null ? h('span', { class: 'warn-text', text: `The new commits could not be listed${o.commitsError ? ` (${o.commitsError})` : ''}.` })
    : o.commits?.length ? h('ul', { class: 'bullets' }, o.commits.map(c => h('li', {}, h('code', { text: String(c.sha ?? '').slice(0, 12) }), ` ${c.title ?? ''}`)), o.commitCount > o.commits.length ? h('li', { text: `and ${o.commitCount - o.commits.length} more` }) : null) : undefined) : undefined;
  return card('Candidate', h('div', { class: 'stack' }, kv([
    ['Pull request', m.pullRequest ? externalLink(prUrl, `${m.pullRequest.number ? `#${m.pullRequest.number}` : 'Pull request'}${m.pullRequest.adopted ? ' (adopted)' : adopted ? ` (replaces adopted #${adopted.number})` : ''}`) : h('span', { class: 'muted', text: 'Not published' })],
    ['Original pull request', adopted ? h('span', {}, externalLink(originalUrl, `#${adopted.number}`), ' ', originalState) : undefined],
    ['Not delivered', undelivered],
    ['Candidate commit', m.candidate ? h('span', {}, h('code', { text: m.candidate.slice(0, 12) }), commitUrl ? [' · ', externalLink(commitUrl, 'Commit')] : null) : h('span', { class: 'muted', text: 'Not recorded' })],
    ['Base', m.base ? h('code', { text: m.base.slice(0, 12) }) : undefined],
    ['Review', review ? h('span', {}, chip(review.verdict === 'pass' ? 'passed' : review.verdict ?? ROUTE_STATUS[review.route] ?? 'unknown', review.verdict ?? review.route ?? 'not recorded'), ` ${review.findings === 1 ? '1 finding' : `${review.findings} findings`}${item.reviewDecision ? ` (${mustFixCounts(item.reviewDecision.counts)})` : severities ? ` (${severities})` : ''}${review.phase ? ` · ${review.phase} review` : ''}`, review.current ? null : h('span', { class: 'warn-text', text: ' · recorded for another commit' })) : h('span', { class: 'muted', text: 'No review recorded' })],
    ['Checks', checkSummary(m.gate, 'No gate result recorded')],
    ['Fast checks', m.fastChecks ? checkSummary(m.fastChecks, '') : undefined],
    ['Changes', diffUrl ? externalLink(diffUrl, `View the changes on ${host}`) : h('span', { class: 'muted', text: forge ? 'No link: the recorded pull request is not on the configured repository' : 'No forge link: no repository is configured' })]], 'compact'),
    review?.summary ? h('p', { class: 'preline small', text: `Review summary: ${review.summary}` }) : null,

    adopted ? h('p', { class: 'help', text: 'An adopted pull request’s merge question is answered by the operator only. This flow delivers only the adopted head; commits pushed to the original afterwards are not included.' }) : null), { cls: 'merge-candidate' });
}

// A must-fix flow's merge or satisfied question (review-must-fix design 12.3, 11.5; test fixtures only
// until the enabling release): in place of severity counts, the must-fix counts; the purpose
// assessment; why the decision is the operator's; and every finding that was not fixed, operator items
// first, with its scenario, class, reachability, each citation's validation, its support, who deferred
// or excluded it and each counted judgement with the reviewer's model family. Validated is never shown
// as verified: it says the cited thing exists, not that it supports the claim.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const mustFixCounts = c => c ? [plural(c.mustFixOpen ?? 0, 'must-fix open', 'must-fix open'), plural(c.operatorItems ?? 0, 'operator item'), plural(c.followUps ?? 0, 'follow-up'), plural(c.deferrals ?? 0, 'deferral')].join(', ') : '';
const GUARD_REASON = { 'operator-items': 'operator items need your acceptance', critical: 'a reviewer rated a finding critical', 'purpose-missing': 'the review has no purpose assessment', 'purpose-not-met': 'the outcome or a criterion is not shown to be met', 'silent-wrong-answer': 'a silent wrong answer is not ruled out', 'row-overflow': 'more findings than the flow records as rows', restricted: 'the review restriction (operatorDisposition all) is active' };
const KIND_LABEL = { 'operator-item': 'Operator item', 'follow-up': 'Follow-up', 'must-fix': 'Must-fix (adjudicated)', purpose: 'Purpose assessment' };
export function acknowledgementText(row) {
  if (row.kind === 'purpose') return row.id === 'purpose:silent-wrong-answer' ? `Silent wrong answer: ${row.answer ?? 'not assessed'}${row.settle ? `. What would settle it: ${row.settle}` : ''}${row.how ? `. How: ${row.how}` : ''}` : `Outcome ${row.outcome ?? 'not assessed'}${row.unverified?.length ? `; not verified: ${row.unverified.join('; ')}` : ''}${row.notMet?.length ? `; not met: ${row.notMet.join('; ')}` : ''}`;
  const citations = (row.citations ?? []).length ? `citations ${row.citations.join(', ')}` : 'no citations';
  return [`${row.scenario ?? row.message ?? ''}`, row.purposeImpact ? `class ${row.purposeImpact}` : null, row.reachable ? `reachability ${row.reachable.reported}${row.reachable.read !== row.reachable.reported ? `, read as ${row.reachable.read}` : ''}` : null, citations, row.support ? `support ${row.support}` : null,
    row.deferral ? `deferred by the builder (${row.deferral.reason}) in round ${row.deferral.round}: ${row.deferral.void ? 'void' : row.deferral.outcome ?? 'awaiting judgement'}` : null, row.excludedByFamily ? `excluded by a reviewer on ${row.excludedByFamily}` : null, row.confirmedByFamily ? `confirmed by a reviewer on ${row.confirmedByFamily}` : null,
    (row.judgements ?? []).length ? `judged ${row.judgements.map(j => `${j.judgement} (round ${j.round}${j.family ? `, ${j.family}` : ''})`).join('; ')}` : null, row.operatorDisposition ? `operator: ${row.operatorDisposition}` : null].filter(Boolean).join(' · ');
}
function reviewDecisionView(item) {
  const g = item.reviewDecision, list = item.strictReview?.acknowledgements ?? g.acknowledgements ?? [];
  const purposeRows = list.filter(row => row.kind === 'purpose');
  return card('Review findings', h('div', { class: 'stack' },
    kv([['Findings', mustFixCounts(g.counts)], ['Purpose', purposeRows.length ? purposeRows.map(acknowledgementText).join(' | ') : 'outcome and every criterion met; no silent wrong answer'], ['Decided by', g.operator ? `you: ${g.reasons.map(row => GUARD_REASON[row.reason] ?? row.reason).join('; ')}` : item.strictReview ? `the strict decision role${item.strictReview.operatorOnly ? ' (you: an operator-only finding is listed)' : ''}` : 'as configured'],
      ['Restriction', g.restriction?.version ? `version ${g.restriction.version}${g.restriction.operatorDisposition === 'all' ? ', every finding is yours to accept' : ''}${g.restriction.protectedClassDeferral === false ? ', protected-class deferral restricted' : ''}` : undefined],
      ['Blocked', g.blocked?.length ? `open must-fix items ${g.blocked.join(', ')}: send the change back` : undefined]], 'compact'),
    list.length ? h('ol', { class: 'ack-list' }, list.map(row => h('li', {}, h('strong', { text: `${row.id} · ${KIND_LABEL[row.kind] ?? row.kind}` }), row.reason ? ` (${row.reason})` : '', row.operatorOnly ? h('span', { class: 'warn-text', text: ' · operator only' }) : null, h('div', { class: 'small', text: acknowledgementText(row) }), h('div', { class: 'muted small' }, 'claim ', h('code', { text: short(row.claimDigest, 16) }))))) : h('p', { class: 'muted', text: 'Nothing left to acknowledge.' }),
    g.acknowledgementsOmitted ? h('p', { class: 'warn-text', text: `${g.acknowledgementsOmitted} more are listed in the question record; answer from the command line with every one of them.` }) : null,
    h('p', { class: 'help', text: '“Validated” means the cited text, fact or record exists as cited, not that it supports the claim.' })), { cls: 'review-findings' });
}
// The merge or accept answer of a question that lists findings to acknowledge: one check box per
// finding, sending the claim digests this page shows; a changed finding makes the project refuse it,
// and the refreshed page shows the change.
function acknowledgementForm(project, item, answer, expired) {
  const list = item.strictReview?.acknowledgements ?? item.reviewDecision.acknowledgements, strict = Boolean(item.strictReview);
  return commandForm(project, { key: `acknowledge:${item.id}:${answer}`, title: answer === 'merge' ? 'Acknowledge and authorize the merge' : 'Acknowledge and accept', operation: 'answer', variant: 'primary', subject: { label: `question ${short(item.id, 8)}`, version: item.subjectDigest },
    intro: `Check each finding you accept for this ${strict ? `exact candidate ${String(item.strictReview.head).slice(0, 12)}` : 'decision'}. The page sends the claim digests it shows.`,
    fields: list.map((row, index) => ({ name: `ack${index}`, type: 'checkbox', label: `${row.id} · ${KIND_LABEL[row.kind] ?? row.kind}${row.reason ? ` (${row.reason})` : ''}${row.operatorOnly ? ' · operator only' : ''}`, help: `${acknowledgementText(row).slice(0, 400)} · claim ${short(row.claimDigest, 16)}` })),
    payload: values => { if (list.some((_, index) => values[`ack${index}`] !== 'true')) throw new Error('Check every listed finding to acknowledge it, or send the change back with a note.'); return { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer, ...(strict ? { reviewedHead: item.strictReview.head } : {}), acknowledgedFindings: list.map(row => ({ id: row.id, claimDigest: row.claimDigest })) }; },
    confirm: `Acknowledge ${list.length === 1 ? 'this finding' : `these ${list.length} findings`} and ${answer === 'merge' ? 'authorize the merge' : 'accept the outcome'}?`, reasons: expired ? ['The question has expired.'] : item.reviewDecision?.blocked?.length ? ['A must-fix item is open: send the change back.'] : [], explainRejection: staleAnswer(item.id), submitLabel: answer === 'merge' ? 'Authorize merge' : 'Accept' });
}

// Questions the planner or builder went ahead on without an answer (dev.83), from the merge
// question's own carriedQuestions field: read before merging. A changed answer shows its earlier
// versions; questions the flow could not keep are counted and located, never left out silently.
const answered = row => `${row.assumption ? ` Assumed: ${row.assumption}` : ' No answer assumed.'}${row.answer === 'proceed' ? ` The ${row.answeredBy} chose to proceed${row.note ? ` (note: ${row.note})` : ''}.` : ''}`;
function carriedQuestionsView(carried) {
  const rows = Array.isArray(carried?.questions) ? carried.questions : [], overflow = carried?.overflow;
  if (!rows.length && !overflow) return null;
  return card(`Went ahead without an answer (${rows.length}${overflow ? ` + ${overflow.count} not kept` : ''})`, h('div', { class: 'stack' },
    h('p', { class: 'help', text: 'The planner or builder did not need these answered to go on and assumed the answers shown. Check them before merging; send back with a note if one is wrong.' }),
    rows.length ? h('ol', {}, rows.map(row => h('li', {}, h('span', { text: `${row.from === 'builder' ? 'Builder' : 'Planner'}: ${row.question}` }), h('span', { class: 'muted', text: answered(row) }),
      row.history?.length ? h('div', { class: 'warn-text small', text: `Changed during the flow. Earlier: ${row.history.map(v => `${v.from === 'builder' ? 'builder' : 'planner'} —${answered(v)}`).join(' Then: ')}${row.olderVersions ? ` (${row.olderVersions} older not kept)` : ''}` }) : null))) : null,
    overflow ? h('p', { class: 'warn-text', text: `${overflow.count} more question${overflow.count === 1 ? '' : 's'} could not be kept on the flow, and the reviewers did not see ${overflow.count === 1 ? 'it' : 'them'}: the plan reviewer, the builder and the code reviewer were given only the list above, marked incomplete. Read ${overflow.attemptIds?.length ? `the action-result.json of attempt ${overflow.attemptIds.join(', ')}${overflow.omittedAttempts ? ` and of ${overflow.omittedAttempts} earlier attempt${overflow.omittedAttempts === 1 ? '' : 's'} (in the flow’s attempt history)` : ''}` : 'the plan and build attempts’ results'} before merging.` }) : null), { cls: 'carried-questions' });
}
// A refused answer to a question someone else settled first: say what the project now records.
export const staleAnswer = itemId => (project, error) => {
  if (!/stale or resolved question|question expired/.test(String(error ?? ''))) return '';
  const item = (project?.snapshot?.inbox ?? []).find(row => row.id === itemId);
  // The refusal already says it was answered, and by whom (core/stale-question.mjs, dev.85 I4): add when, and where it is.
  const told = /already answered|this answer was not applied|read it again/.test(String(error));
  if (!item || item.status === 'open') return told ? '' : 'Refresh and read the question again before answering.';
  if (told) return `${item.answeredAt && item.status === 'answered' ? `It was answered ${relative(item.answeredAt)}. ` : ''}It is under Inbox → Resolved.`;
  if (item.status === 'answered') {
    const label = item.choices?.find(choice => choice.id === item.answer)?.label ?? item.answer;
    return `It had already been answered “${label}” by the ${item.relay ? `${item.relay.relayedBy} (relayed)` : item.answeredBy ?? 'project'}${item.answeredAt ? ` ${relative(item.answeredAt)}` : ''}; your answer was not applied. It is under Inbox → Resolved.`;
  }
  return `The question is now ${item.status}; your answer was not applied. It is under Inbox → Resolved.`;
};
// A heading for an inbox item: its title or question; a title-less notice gets its first sentence.
export function itemHeading(item) {
  if (item.title || item.question) return item.title ?? item.question;
  const text = String(item.summary ?? item.context ?? item.id), first = text.split(/(?<=[.!?])\s+/)[0];
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}
function decisionCard(project, item, focused) {
  // Expiry matters only to an open question; a resolved one keeps its own status.
  const expired = item.status === 'open' && Date.parse(item.expiresAt) <= Date.now();
  const flow = (project.snapshot.flows ?? []).find(f => f.id === item.flowId);
  const article = h('article', { class: ['decision', focused ? 'focused' : ''], id: `decision-${item.id}`, tabindex: '-1' },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow', text: project.name }), h('h3', { text: localizeTimes(itemHeading(item)) })), chip(expired ? 'expired' : item.status, expired ? 'Expired' : item.status)),
    kv([['Flow', item.flowId ? link(detailHref({ projectId: project.projectId, flow: item.flowId }), flow ? flowName(flow) : flowTitle(project, item.flowId)) : '—'], ['Task', flow?.taskSnapshot?.title ?? flow?.taskId ?? '—'], ['Step', flow?.step ?? '—'], ['Opened', timeNode(item.createdAt)], ['Expires', item.expiresAt ? timeNode(item.expiresAt) : '—'], ['Decided by', item.role]], 'compact'));
  if(item.context)article.append(h('p',{class:'preline',text:localizeTimes(item.context)}));
  if(item.standalone&&item.question&&item.question!==item.title)article.append(h('p',{text:item.question}));
  // Item links: https or a host thread link, without credentials; anything else is shown as text.
  if(item.links?.length)article.append(h('p',{},item.links.map(itemLink=>{const url=safeUrl(itemLink.url,['https:','t3-thread:']);return url?link(url,itemLink.label):h('span',{text:`${itemLink.label} (${itemLink.url}, not linked)`});})));
  if (item.status === 'open' && item.mergeContext) article.append(mergeCandidateView(project, item));
  if (item.carriedQuestions) article.append(carriedQuestionsView(item.carriedQuestions));
  if (item.preview) article.append(previewCard(project, item.preview));
  if (item.strictReview) article.append(card('Strict review', h('div', {},
    h('p', { text: 'Read the exact candidate below (its commit, changes and any preview) before authorizing it.' }),
    h('h4', { text: 'Threat model' }), h('ul', {}, (item.strictReview.threatModel ?? []).map(text => h('li', { text }))), h('h4', { text: 'Stop conditions' }), h('ul', {}, (item.strictReview.stopConditions ?? []).map(text => h('li', { text }))), raw('Review binding', item.strictReview))));
  if (item.reviewDecision) article.append(reviewDecisionView(item));
  if (item.integration) article.append(card('Workflow authorization', h('div', {},
    kv([['Workflow', item.integration.workflowId], ['Candidate', item.integration.candidate?.head], ['Spending cap', new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format((item.integration.capMicros ?? 0)/1000000)], ['Allocations', JSON.stringify(item.integration.allocationsMicros ?? {})]]),
    h('p',{class:'help',text:'Approval applies to the displayed candidate, configured workflow, cap and retained evidence. Review the evidence before authorizing an external action.'}), raw('Retained workflow evidence', item.integration.evidence))));
  if (item.purpose === 'decision') article.append(notice('info', 'Bound to a durable decision', `This card presents decision ${short(item.decision.decisionId, 12)} at version ${item.decision.version}. Choosing an option answers that exact version as the operator. Discuss, withdrawal, reading or expiry leave the decision unresolved; it still holds ${(item.decision.requiredAt ?? []).join(', ')}.`));
  // A prompt channel (a host's interactive prompt, say) may be showing this question too. Either route settles both.
  for (const shown of item.presentations ?? []) {
    if (shown.status === 'pending' && item.status === 'open') article.append(notice('info', `Also being asked on ${shown.channel}`, h('span', {}, `The ${shown.presentedBy} is showing this question there until `, timeNode(shown.expiresAt), '. Answer here or there: either settles both. An answer given there is recorded as relayed by whoever enters it, with your words verbatim. If no answer arrives in time, that prompt is withdrawn and the question stays open here.')),
      h('details', {}, h('summary', { text: `Withdraw the prompt on ${shown.channel}` }), commandForm(project, { key: `unpresent:${item.id}:${shown.id}`, title: 'Withdraw the prompt, keep the question', operation: 'inbox.unpresent', subject: { label: `prompt for inbox item ${short(item.id, 8)}`, version: item.version },
        fields: [{ name: 'reason', type: 'textarea', label: 'Why the prompt should be taken down', required: true }], payload: values => ({ inboxId: item.id, presentationId: shown.id, reason: values.reason }), submitLabel: 'Withdraw the prompt', variant: 'ghost' })));
    else article.append(h('p', { class: 'muted' }, `Prompt on ${shown.channel} (shown by the ${shown.presentedBy} `, relativeTimeNode(shown.presentedAt), `): ${shown.status}`, shown.endedAt ? [' ', relativeTimeNode(shown.endedAt)] : '', shown.reason ? ` — ${shown.reason}` : ''));
  }
  if (item.standalone && item.status === 'open') article.append(h('details', {}, h('summary', { text: 'Withdraw this item' }), commandForm(project, {
    key: `withdraw:${item.id}`, title: 'Withdraw without answering', operation: 'inbox.withdraw', subject: { label: `inbox item ${short(item.id, 8)}`, version: item.version },
    fields: [{ name: 'reason', type: 'textarea', label: 'Why it no longer needs an answer', required: true }],
    payload: values => ({ inboxId: item.id, expectedVersion: item.version, reason: values.reason }), confirm: item.purpose === 'decision' ? 'Withdraw this card? It stops reminders. The decision stays unresolved and keeps holding its task.' : 'Withdraw this item? It stops reminders and cannot be answered afterwards.', submitLabel: 'Withdraw', variant: 'ghost',
  })));
  if (item.kind === 'notice') {
    // A notice without a title is headed by its first sentence; the body shows the rest once.
    const body = item.summary ?? (item.context ? null : 'No decision is requested.'), heading = itemHeading(item);
    article.append(notice('info', 'Operational notice', body && body !== heading ? localizeTimes(body) : 'No decision is requested.'));
    if (item.blockers) article.append(h('ul', {}, item.blockers.map(row => h('li', { text: `${row.taskId}: ${row.reasons.length ? row.reasons.join('; ') : 'Observed ready; inspect dispatch health'}` }))));
    if(item.status==='open')article.append(commandButton(project,{key:`ack:${item.id}`,label:'Acknowledge notice',operation:'inbox.ack',payload:{inboxId:item.id},subject:{label:item.title??'notice',version:item.version}}));
  } else if (item.withdrawal) article.append(h('p', { class: 'muted' }, `Withdrawn by ${item.withdrawal.actor} `, relativeTimeNode(item.withdrawal.at), `: ${item.withdrawal.reason}`));
  else if (item.status !== 'open') {
    article.append(h('p', { class: 'muted' }, ...(item.answer ? [`Answered “${item.choices?.find(choice=>choice.id===item.answer)?.label??item.answer}” `, item.answeredAt ? relativeTimeNode(item.answeredAt) : '', item.answeredBy ? ` by the ${item.answeredBy}` : ''] : [`Status: ${item.status}`])));
    if (item.answerNote) article.append(h('p', { class: 'muted', text: `Note: ${item.answerNote}` }));
    // A relayed answer is never shown as the operator's own: who entered it, where the words came from, and the words.
    if (item.relay) article.append(notice('info', 'Relayed answer', `Entered by the ${item.relay.relayedBy}, relaying words received on ${item.relay.channel}: “${item.relay.quote}”. It is recorded as relayed, not as a direct operator answer.`));
  }
  else if (['operator','orchestrator'].includes(item.role) && Array.isArray(item.answers)) {
    article.append(h('p', { class: 'help', text: 'Answers are sent to this project only, with the question version shown above. A changed subject is rejected by the project.' }));
    // A must-fix flow's question that lists findings to acknowledge answers merge (or accept) through a form with one check box per finding.
    const ackList = item.strictReview?.acknowledgements ?? (item.reviewDecision?.operator ? item.reviewDecision.acknowledgements : null);
    const ackAnswer = ackList?.length ? item.answers.find(answer => ['merge', 'accept'].includes(answer)) : null;
    const strictAnswer = !ackAnswer && item.strictReview && item.answers.find(answer => ['merge', 'accept'].includes(answer));
    // A plan question's proceed takes an optional note too (answers for the plan reviewer and builder).
    const feedbackAnswers = item.answers.filter(answer=>['send_back','repair','retry','replan','blocked'].includes(answer)||answer==='proceed'&&item.planQuestion);
    const choice = answer => item.choices?.find(row=>row.id===answer);
    const noteLabel = answer => answer==='blocked'?'Why it is blocked':item.planQuestion&&answer==='replan'?'Your answers to the planner’s questions':item.planQuestion&&answer==='proceed'?'Answers or assumptions for the plan reviewer and builder (optional)':item.buildQuestion&&answer==='retry'?'Your answers to the builder’s questions':'Feedback for the worker';
    for (const answer of feedbackAnswers) article.append(commandForm(project, {
      key:`feedback:${item.id}:${answer}`,title:choice(answer)?.label??`Answer “${answer}” with feedback`,intro:choice(answer)?.description,operation:'answer',subject:{label:`question ${short(item.id,8)}`,version:item.subjectDigest},
      fields:[{name:'note',type:'textarea',label:noteLabel(answer),required:['send_back','repair','blocked'].includes(answer)}],
      payload:values=>({inboxId:item.id,version:item.version,subjectDigest:item.subjectDigest,answer,...(values.note?{note:values.note}:{})}),
      reasons:expired?['The question has expired.']:[],explainRejection:staleAnswer(item.id),confirm:`Send “${choice(answer)?.label??answer}”${choice(answer)?'':' and this feedback'}?`,submitLabel:choice(answer)?.label??`Answer “${answer}”`,
    }));
    // The candidate on display is the one authorized: the button sends the head this page shows,
    // and the project refuses it if the candidate or question has changed since.
    if (strictAnswer) article.append(h('div', { class: 'stack' }, candidateLinks(project, item, flow),
      commandButton(project, { key: `strict-merge:${item.id}`, label: strictAnswer === 'merge' ? 'Authorize merge' : 'Authorize', operation: 'answer', variant: 'primary',
        payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: strictAnswer, reviewedHead: item.strictReview.head },
        subject: { label: `strict candidate ${item.strictReview.head.slice(0, 12)}`, version: item.subjectDigest },
        confirm: `Authorize ${strictAnswer} of commit ${item.strictReview.head.slice(0, 12)}, the candidate shown here?`, reasons: expired ? ['The question has expired.'] : [], explainRejection: staleAnswer(item.id) })));
    if (ackAnswer) article.append(h('div', { class: 'stack' }, item.strictReview ? candidateLinks(project, item, flow) : null, acknowledgementForm(project, item, ackAnswer, expired)));
    article.append(h('div', { class: 'button-row answers' }, item.answers.filter(a => typeof a === 'string' && a !== strictAnswer && a !== ackAnswer && !feedbackAnswers.includes(a)).map(answer => commandButton(project, {
      key: `answer:${item.id}:${answer}`, label: item.choices?.find(choice=>choice.id===answer)?.label ?? (answer === 'stop' ? 'Stop flow' : `Answer “${answer}”`), help:item.choices?.find(choice=>choice.id===answer)?.description, operation: 'answer', variant: answer === 'stop' ? 'danger' : 'primary',
      payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer }, subject: { label: `question ${short(item.id, 8)}`, version: item.version },
      confirm: `Send “${item.choices?.find(choice=>choice.id===answer)?.label??answer}” to ${project.name}`, reasons: expired ? ['The question has expired; the project will not accept an answer.'] : [], showReasons: answer === item.answers[0], explainRejection: staleAnswer(item.id),
    }))));
  } else article.append(notice('info', `Waiting for ${item.role ?? 'project'} action.`, item.autoMerge ? 'Configured policy may answer this question; it is shown for visibility.' : 'No operator answer is accepted for this question.'));
  article.append(raw('Decision record', item));
  return article;
}

// A durable decision, shown apart from any card that presents it: its task revision,
// scope and options, the boundaries it holds, and its disposition history. Only
// substantive dispositions are offered; there is no generic "resolve" for a decision.
const DECISION_STATUS = { unresolved: 'Unresolved', resolved: 'Answered', canceled: 'Canceled', superseded: 'Superseded' };
export function durableDecisionCard(project, d) {
  const task = (project.snapshot.tasks ?? []).find(t => t.id === d.taskId), subject = { label: `decision ${short(d.id, 12)}`, version: d.version };
  const open = d.status !== 'superseded' && d.applicability.some(a => a.state !== 'covered');
  const article = h('article', { class: 'decision', id: `durable-${d.id}` },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow', text: `${project.name} · durable decision` }), h('h3', { text: d.question })), chip(d.blocks.length ? 'held' : d.status, d.blocks.length ? `Holds ${d.blocks.join(', ')}` : DECISION_STATUS[d.status] ?? d.status)),
    kv([['Task', task?.title ?? d.taskId], ['Current revision', d.currentRevision ? short(d.currentRevision, 12) : '—'], ['Status', DECISION_STATUS[d.status] ?? d.status], ['Why held', d.holdReason ?? undefined], ['Choice', d.scope.choiceId], ['Required before', d.requiredAt.join(', ')], ['Version', String(d.version)], ['Opened', timeNode(d.createdAt)]]));
  if (d.rationale) article.append(h('p', { class: 'preline', text: d.rationale }));
  article.append(h('h4', { text: 'Options' }), h('ul', {}, d.options.map(o => h('li', { text: o.label }))));
  if (d.applicability.length > 1) article.append(h('p', { class: 'muted small', text: `Applies to ${d.applicability.length} task revisions: ${d.applicability.map(a => `${short(a.revision, 8)} (${a.state})`).join(', ')}.` }));
  if (d.clearanceLapse) article.append(notice('warning', 'Clearance lapsed with its grant', `${d.clearanceLapse}. The answer stays in the history but no longer clears this decision; ratify it unchanged or answer anew.`));
  // Relayed answers: the operator's words as entered by someone else. They settle nothing until the operator confirms one here.
  const relays = (d.relayedAnswers ?? []);
  if (relays.length) article.append(h('h4', { text: 'Relayed answers' }), h('ul', {}, relays.map(r => h('li', {}, `${r.status === 'pending' ? 'Awaiting your confirmation' : r.status}: the ${r.relayedBy} relayed “${r.quote}” from ${r.channel} as “${d.options.find(o => o.id === r.optionId)?.label ?? r.optionId}” `, relativeTimeNode(r.createdAt), r.resolvedReason ? ` — ${r.resolvedReason}` : ''))));
  if ((d.grantCoverage ?? []).length) article.append(h('h4', { text: 'Grants naming this decision' }), h('ul', {}, d.grantCoverage.map(g => h('li', {}, `${g.grantId}/${g.entryId}: ${g.disposition}${g.answers ? ` ${g.answers.join(' or ')}` : ''} at version ${g.obligationVersion}; used ${g.used} of ${g.maxUses}; `, g.current ? ['current until ', timeNode(g.expiresAt)] : g.status === 'revoked' ? 'revoked' : 'not current'))));
  if (d.dispositions.length) article.append(h('h4', { text: 'History' }), h('ul', {}, d.dispositions.map(x => h('li', {}, `${x.status === 'active' ? 'Active' : 'Inactive'} ${x.kind}${x.answer ? ` “${d.options.find(o => o.id === x.answer.optionId)?.label ?? x.answer.optionId}”` : ''}${x.ratifiesDispositionId ? ' (ratified)' : ''} `, relativeTimeNode(x.createdAt), `: ${x.rationale}${x.inactiveReason ? ` — ${x.inactiveReason}` : ''}`))));
  if (open) {
    article.append(h('p', { class: 'help', text: 'Answering here is a direct operator disposition of this exact decision version. A changed decision is refused by the project; refresh and read it again.' }));
    for (const o of d.options) article.append(commandForm(project, { key: `dispose:${d.id}:${o.id}`, title: `Answer “${o.label}”`, operation: 'decision.dispose', subject,
      fields: [{ name: 'rationale', type: 'textarea', label: 'Rationale', required: true }],
      payload: v => ({ decisionId: d.id, expectedDecisionVersion: d.version, kind: 'answer', optionId: o.id, rationale: v.rationale }), confirm: `Answer “${o.label}” for ${task?.title ?? d.taskId}?`, submitLabel: 'Answer', variant: 'secondary' }));
    article.append(h('details', {}, h('summary', { text: 'Cancel the affected work instead' }), commandForm(project, { key: `cancel:${d.id}`, title: 'Cancel this scope', operation: 'decision.dispose', subject,
      fields: [{ name: 'reason', type: 'textarea', label: 'What is canceled', required: true }, { name: 'rationale', type: 'textarea', label: 'Rationale', required: true }],
      payload: v => ({ decisionId: d.id, expectedDecisionVersion: d.version, kind: 'cancel', reason: v.reason, rationale: v.rationale }), confirm: 'Cancel this scope? The task cannot be delivered at these revisions until its brief changes and the decision is settled again.', submitLabel: 'Cancel scope', variant: 'danger' })));
    for (const r of relays.filter(x => x.status === 'pending' && x.decisionVersion === d.version)) {
      const option = d.options.find(o => o.id === r.optionId);
      article.append(commandForm(project, { key: `confirm-relay:${d.id}:${r.id}`, title: `Confirm the relayed answer “${option?.label ?? r.optionId}”`, operation: 'decision.dispose', subject,
        fields: [{ name: 'rationale', type: 'textarea', label: 'Rationale', required: true, help: `Relayed by the ${r.relayedBy} from ${r.channel}: “${r.quote}”. Confirming is your own direct answer and cites the relay.` }],
        payload: v => ({ decisionId: d.id, expectedDecisionVersion: d.version, kind: 'answer', optionId: r.optionId, relayedAnswerId: r.id, rationale: v.rationale }), confirm: `Confirm “${option?.label ?? r.optionId}” as your answer?`, submitLabel: 'Confirm answer', variant: 'secondary' }));
    }
    // A grant to the orchestrator for one exact answer of this exact version. The entry is shown before issue.
    if (d.status === 'unresolved' && d.applicability.length === 1 && d.appliesToCurrentRevision) for (const o of d.options) {
      const entry = { operation: 'decision.dispose', disposition: 'answer', taskId: d.taskId, taskRevision: d.currentRevision, obligationId: d.id, obligationVersion: d.version, scopeDigest: d.scopeDigest, optionSetDigest: d.optionSetDigest, answers: [{ optionId: o.id, payloadDigest: o.payloadDigest }], maxUses: 1 };
      article.append(h('details', {}, h('summary', { text: `Let the orchestrator answer “${o.label}” (exact grant)` }),
        h('p', { class: 'help', text: 'This grant lets the orchestrator settle this decision version with exactly this answer, once. Anything else (another answer, a changed decision, another task) is refused. The answer clears the decision only while the grant is unrevoked and unexpired; revoking it or letting it expire makes the decision unresolved again for future work, without undoing what was already done.' }),
        h('pre', { class: 'small', text: JSON.stringify(entry, null, 2) }),
        commandForm(project, { key: `grant-answer:${d.id}:${o.id}`, title: 'Issue this exact grant', operation: 'grant.issue', subject,
          fields: [{ name: 'hours', label: 'Valid for (hours)', value: '24', required: true }],
          payload: v => ({ expiresAt: new Date(Date.now() + Math.max(1, Math.min(720, Number(v.hours) || 24)) * 3600000).toISOString(), entries: [entry], reason: `Console: orchestrator may answer “${o.label}” on decision ${d.id} version ${d.version}` }), confirm: `Issue a grant for exactly “${o.label}” on this decision version?`, submitLabel: 'Issue grant', variant: 'secondary' })));
    }
    if (!d.cards.some(c => c.status === 'open' && c.decisionVersion === d.version)) article.append(commandButton(project, { key: `present:${d.id}`, label: 'Present in the inbox', operation: 'decision.present', payload: { decisionId: d.id, expectedDecisionVersion: d.version }, subject, variant: 'ghost' }));
    for (const prior of d.ratifiable ?? []) article.append(commandForm(project, { key: `ratify:${d.id}:${prior}`, title: 'Ratify the earlier answer unchanged', operation: 'decision.ratify', subject,
      fields: [{ name: 'rationale', type: 'textarea', label: 'Rationale', required: true }],
      payload: v => ({ decisionId: d.id, expectedDecisionVersion: d.version, inactiveDispositionId: prior, rationale: v.rationale }), submitLabel: 'Ratify', variant: 'secondary' }));
  }
  const active = d.dispositions.find(x => x.status === 'active');
  if (active && ['resolved', 'canceled'].includes(d.status)) article.append(h('details', {}, h('summary', { text: 'Revoke this disposition' }), commandForm(project, { key: `revoke:${d.id}`, title: 'Revoke', operation: 'decision.revoke', subject,
    fields: [{ name: 'reason', type: 'textarea', label: 'Why', required: true }],
    payload: v => ({ decisionId: d.id, expectedDecisionVersion: d.version, dispositionId: active.id, reason: v.reason }), confirm: 'Revoke? The decision becomes unresolved and holds its task again. Work already dispatched is not undone; it is recorded as an authority race.', submitLabel: 'Revoke', variant: 'danger' })));
  article.append(raw('Decision ledger record', d));
  return article;
}

// A to-do: something still owed after a flow (a post-merge step from the brief, closing the
// source task, a failed cleanup or label update). Resolving it records the outcome and evidence.
function todoCard(project, o) {
  const open = openObligation(o), flow = (project.snapshot.flows ?? []).find(f => f.id === o.flowId);
  const article = h('article', { class: 'decision', id: `todo-${o.id}` },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow', text: `${project.name} · to-do` }), h('h3', { text: o.title ?? o.text ?? o.id })), chip(open ? 'open' : o.status, open ? 'To do' : o.status)),
    kv([['Flow', o.flowId ? link(detailHref({ projectId: project.projectId, flow: o.flowId }), flow ? flowName(flow) : flowTitle(project, o.flowId)) : '—'], ['Owner', o.owner ?? 'operator'], ['Evidence', o.evidence ?? undefined], ['Created', o.createdAt ? timeNode(o.createdAt) : undefined], ['Resolved', o.resolvedAt ? timeNode(o.resolvedAt) : undefined], ['Note', o.note ?? undefined]]));
  if (open) article.append(commandForm(project, { key: `obligation:${o.id}`, title: 'Record the outcome', operation: 'obligation.resolve', subject: { label: `to-do ${short(o.id, 16)}`, version: o.status },
    fields: [{ name: 'status', label: 'Outcome', type: 'select', options: [['passed', 'Done'], ['failed', 'Could not be done'], ['deferred', 'Deferred']], value: 'passed' }, { name: 'evidence', label: 'Evidence', required: false }, { name: 'note', label: 'Note', required: false }],
    payload: v => ({ obligationId: o.id, status: v.status, ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.note ? { note: v.note } : {}) }), variant: 'secondary' }));
  article.append(raw('To-do record', o));
  return article;
}

// Stored operator grants: exact entries, usage and validity, with revocation; and an exact
// batch approval grant for the tasks currently awaiting approval, shown entry by entry before issue.
function grantCard(project, g) {
  const article = h('article', { class: 'decision', id: `grant-${g.id}` },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow', text: `${project.name} · operator grant` }), h('h3', { text: g.id })), chip(g.current ? 'open' : g.status, g.current ? 'Current' : g.lapse ?? g.status)),
    kv([['Grantee', g.grantee], ['Valid from', timeNode(g.notBefore)], ['Expires', timeNode(g.expiresAt)], ['Status', g.status], ['Version', String(g.version)]]),
    h('ul', {}, g.entries.map(e => h('li', { text: `${e.entryId}: ${e.operation} ${e.disposition} · task ${e.taskId} @ ${short(e.taskRevision, 8)}${e.obligationId ? ` · decision ${e.obligationId} v${e.obligationVersion}${e.answers ? ` · ${e.answers.map(a => a.optionId).join(' or ')}` : ''}` : ''} · used ${e.used} of ${e.maxUses}` }))));
  if (g.status === 'active') article.append(h('details', {}, h('summary', { text: 'Revoke this grant' }), commandForm(project, { key: `grant-revoke:${g.id}`, title: 'Revoke', operation: 'grant.revoke', subject: { label: `grant ${g.id}`, version: g.version },
    fields: [{ name: 'reason', type: 'textarea', label: 'Why', required: true }],
    payload: v => ({ grantId: g.id, expectedVersion: g.version, reason: v.reason }), confirm: 'Revoke? Unused entries stop working, approvals obtained through it are withdrawn and their flows stopped, and decisions it cleared become unresolved. Work already done is not undone.', submitLabel: 'Revoke grant', variant: 'danger' })));
  article.append(raw('Grant record', g));
  return article;
}
function approvalGrantForm(project) {
  const tasks = (project.snapshot.tasks ?? []).filter(t => !t.approved && !t.tracked && !t.closed && t.status !== 'completed' && t.grantPins?.workflowDigest);
  if (!tasks.length) return null;
  const entries = tasks.map(t => ({ operation: 'task.approve', disposition: 'approve', taskId: t.id, taskRevision: t.grantPins.taskRevision, workflowDigest: t.grantPins.workflowDigest, maxUses: 1 }));
  return h('details', {}, h('summary', { text: `Let the orchestrator approve these ${tasks.length} exact task revision${tasks.length === 1 ? '' : 's'} (batch grant)` }),
    h('p', { class: 'help', text: 'Each entry approves exactly one task revision with its selected workflow, once. It never approves a later edit of the brief and never answers a decision. An approval obtained through the grant authorizes work only while the grant is unrevoked and unexpired; revocation or expiry stops further steps without undoing what was already done.' }),
    h('pre', { class: 'small', text: JSON.stringify(entries, null, 2) }),
    commandForm(project, { key: 'grant-approve-batch', title: 'Issue these exact approval entries', operation: 'grant.issue', subject: { label: 'tasks awaiting approval', version: entries.map(e => `${e.taskId}@${e.taskRevision}`).join(',') },
      fields: [{ name: 'hours', label: 'Valid for (hours)', value: '24', required: true }],
      payload: v => ({ expiresAt: new Date(Date.now() + Math.max(1, Math.min(720, Number(v.hours) || 24)) * 3600000).toISOString(), entries, reason: 'Console: exact batch approval grant' }), confirm: `Issue a grant to approve exactly these ${tasks.length} task revision${tasks.length === 1 ? '' : 's'}?`, submitLabel: 'Issue grant', variant: 'secondary' }));
}
// Add a notice or question to this project's inbox; opened from the header, like New task.
export const canPublishInbox = project => Boolean(project && available(project) && project.snapshot.operatorPresence);
export function inboxItemForm(project) {
  return commandForm(project,{key:'inbox.publish',title:'Record a notice or question',operation:'inbox.publish',subject:{label:'new inbox item',version:null},fields:[{name:'kind',type:'select',label:'Item type',value:'notice',options:[['notice','Notice'],['question','Question']]},{name:'title',label:'Title'},{name:'context',type:'textarea',label:'Context and consequences'},{name:'choices',type:'textarea',label:'Question choices, one per line',required:false,help:'For a question, enter two to eight choices. A recorded answer does not approve a task or trigger an external action.'}],payload(values){return{kind:values.kind,title:values.title,context:values.context,...(values.kind==='question'?{question:values.title,choices:values.choices.split('\n').map(line=>line.trim()).filter(Boolean).map((label,index)=>({id:`choice-${index+1}`,label}))}:{})};},submitLabel:'Add inbox item'});
}
export function inboxView(project, route) {
  const ui = uiState('inbox', { filter: 'open' });
  const scope = project ? [project] : state.projects;
  const unreachable = scope.filter(p => !available(p));
  const all = scope.filter(available).flatMap(p => (p.snapshot.inbox ?? []).map(item => ({ p, item })));
  const filtered = all.filter(({ item }) => ui.filter === 'all' || (ui.filter === 'open' ? item.status === 'open' : item.status !== 'open')).sort((a, b) => Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt));
  const todos = scope.filter(available).flatMap(p => (p.snapshot.obligations ?? []).map(o => ({ p, o }))), shownTodos = todos.filter(({ o }) => ui.filter === 'all' || (ui.filter === 'open') === openObligation(o)).sort((a, b) => String(b.o.createdAt).localeCompare(String(a.o.createdAt)));
  const counts = { open: all.filter(x => x.item.status === 'open').length + todos.filter(x => openObligation(x.o)).length, closed: all.filter(x => x.item.status !== 'open').length + todos.filter(x => !openObligation(x.o)).length, all: all.length + todos.length };
  const view = h('div', { class: 'view' });
  view.append(h('div', { class: 'toolbar' }, segmented([['open', 'Open', counts.open], ['closed', 'Resolved', counts.closed], ['all', 'All', counts.all]], ui.filter, value => { ui.filter = value; saveUi(); window.dispatchEvent(new Event('factotum:render')); }, 'Decision status'),
    h('p', { class: 'muted small', text: project ? `Inbox items for ${project.name} (latest 100 recorded).` : 'Combined decisions and notices; each row names its project and routes only to it.' })));
  for (const p of unreachable) view.append(notice('warning', `${p.name}: decisions unknown.`, `The project is ${p.status}; its inbox is not shown as empty.`));
  // Durable decisions (migrated projects) are listed apart from their cards: an unopened or withdrawn card still leaves the hold.
  const decisions = scope.filter(available).flatMap(p => (p.snapshot.decisions ?? []).map(d => ({ p, d }))).filter(({ d }) => ui.filter === 'all' || (ui.filter === 'open') === (d.blocks.length > 0 || d.status === 'unresolved'));
  if (decisions.length) view.append(h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: 'Durable decisions' }), h('div', { class: 'decision-list' }, decisions.map(({ p, d }) => durableDecisionCard(findProject(p.projectId), d)))));
  // Grants (migrated projects): current ones in the open filter, every one in the others.
  const grantProjects = scope.filter(available).filter(p => Array.isArray(p.snapshot.grants));
  const grants = grantProjects.flatMap(p => p.snapshot.grants.filter(g => ui.filter !== 'open' || g.current).map(g => ({ p, g })));
  const approvalForms = ui.filter === 'closed' ? [] : grantProjects.map(p => approvalGrantForm(findProject(p.projectId))).filter(Boolean);
  if (grants.length || approvalForms.length) view.append(h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: 'Operator grants' }), ...approvalForms, h('div', { class: 'decision-list' }, grants.map(({ p, g }) => grantCard(findProject(p.projectId), g)))));
  if (shownTodos.length) view.append(h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: ui.filter === 'open' ? 'To-dos' : 'To-dos (obligations)' }), h('div', { class: 'decision-list' }, shownTodos.map(({ p, o }) => todoCard(findProject(p.projectId), o)))));
  if (shownTodos.length && filtered.length) view.append(h('h2', { class: 'section-title', text: 'Decisions and notices' }));
  if (!filtered.length && !shownTodos.length && !decisions.length) view.append(empty(ui.filter === 'open' ? 'No open inbox items' : 'No inbox items in this filter', ui.filter === 'open' ? 'Reachable projects have no open decisions or notices.' : undefined));
  else if (filtered.length) view.append(h('div', { class: 'decision-list' }, filtered.map(({ p, item }) => decisionCard(findProject(p.projectId), item, route.params.item === item.id))));
  return view;
}
