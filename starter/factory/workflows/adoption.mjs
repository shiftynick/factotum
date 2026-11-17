import { closingReference } from '../adapters/github/index.mjs';
import { markdownText } from './plan-comment.mjs';
import { stripControls } from '../core/text.mjs';

// Adopting an existing pull request (flow.start with candidate {number, head, base}).
// The factory delivers the approved head unchanged through a replacement PR. These helpers
// check the outside commits before any model runs, observe whether the original PR moved
// after adoption, and write the model-free texts the original author and operator read.

const short = sha => String(sha ?? '').slice(0, 12);
const firstLine = message => stripControls(String(message ?? '').split('\n')[0]).trim().slice(0, 200);
const LISTED = 20;

// The merge step refuses closing references in every candidate commit message, and the factory
// cannot reword an outside commit. Check the adopted commits with the same rule and the same
// bounded commit list before anything is integrated, published or reviewed.
export async function adoptionCommitCheck(forge, candidate) {
  const pr = await forge.readPR(candidate.number);
  // A changed PR is refused by the adoption step itself with its own reason.
  if (pr.head !== candidate.head) return { violations: [], url: pr.url ?? null, author: pr.author ?? null };
  // The merge step validates at most 250 commits; a larger PR could never merge.
  if (!(Number.isSafeInteger(pr.commits) && pr.commits > 0 && pr.commits <= 250)) return { violations: [], tooMany: pr.commits ?? null, url: pr.url ?? null, author: pr.author ?? null };
  const commits = await forge.readPRCommits(candidate.number, { expectedHead: candidate.head, expectedCount: pr.commits });
  const violations = commits.flatMap(commit => { const keyword = closingReference(commit.message); return keyword ? [{ sha: commit.sha, keyword, title: firstLine(commit.message) }] : []; });
  return { violations, commits: commits.length, url: pr.url ?? null, author: pr.author ?? null };
}
export function commitLimitHold(candidate, check) {
  const notice = `Adopted pull request #${candidate.number}${check.url ? ` (${check.url})` : ''} cannot be delivered: it has ${check.tooMany ?? 'an unknown number of'} commits, and the merge step checks every commit message through GitHub's pull request commit list, which returns at most 250. Nothing was integrated, published or reviewed. Ask the author to split or squash it, then abandon this flow (flow.abandon) and start a new one (flow.start with the new head as candidate).`;
  return {
    route: 'held',
    adoptionHold: { kind: 'commit-limit', number: candidate.number, head: candidate.head, commits: check.tooMany },
    // The operator-facing notice (the engine stops the flow with it); reason keeps the same text for older readers.
    notice, reason: notice,
  };
}
// The same issue named without a closing verb: "Fixes #28" becomes "Refs #28".
export const plainReference = keyword => String(keyword ?? '').replace(/^\S+?\s*:?\s+/, 'Refs ');
export function closingReferenceHold(candidate, check) {
  const rows = check.violations.slice(0, LISTED).map(v => `commit ${short(v.sha)} ("${v.title}") contains "${v.keyword}"`);
  const more = check.violations.length > LISTED ? `; and ${check.violations.length - LISTED} more` : '';
  const pr = `pull request #${candidate.number}${check.url ? ` (${check.url})` : ''}`;
  const examples = [...new Set(check.violations.slice(0, LISTED).map(v => v.keyword))].slice(0, 3).map(keyword => `"${plainReference(keyword)}" instead of "${keyword}"`);
  const notice = `Adopted ${pr} cannot be delivered: ${rows.join('; ')}${more}. GitHub closes issues named this way when the commit reaches the target, so the merge step refuses it, and the factory does not rewrite outside commits. Nothing was integrated, published or reviewed. Either ask the author to reword the commit message with a plain reference (${examples.join(', ')}) and push, or re-create the commit yourself with a plain reference. Then abandon this flow (flow.abandon) and start a new one (flow.start with the new head as candidate).`;
  return {
    route: 'held',
    adoptionHold: { kind: 'closing-reference', number: candidate.number, head: candidate.head, commits: check.violations.slice(0, LISTED) },
    // The operator-facing notice (the engine stops the flow with it); reason keeps the same text for older readers.
    notice, reason: notice,
  };
}
// The approved candidate does not match the pull request or the target (from adoptCandidate's
// AdoptionMismatch): name each field, what was approved, what was found and how to fix it.
export function candidateMismatchHold(candidate, mismatch, url = null) {
  const rows = (mismatch?.mismatches ?? []).map(row => `${row.field}: approved ${row.expected}, found ${row.found}. Fix: ${row.fix}.`);
  const notice = `Adopted pull request #${candidate.number}${url ? ` (${url})` : ''} does not match the approved candidate {number ${candidate.number}, head ${short(candidate.head)}, base ${short(candidate.base)}}. ${rows.join(' ')} Nothing was integrated, published or reviewed. candidate.head is the pull request's head commit (gh pr view ${candidate.number} --json headRefOid); candidate.base is a commit on the target branch the pull request was approved against, such as the target's current head.`;
  return {
    route: 'held',
    adoptionHold: { kind: 'candidate-mismatch', number: candidate.number, head: candidate.head, mismatches: (mismatch?.mismatches ?? []).map(({ field, expected, found }) => ({ field, expected: String(expected).slice(0, 300), found: String(found).slice(0, 300) })) },
    ...(mismatch?.refs?.length ? { adoptionRefs: mismatch.refs } : {}),
    // The operator-facing notice (the engine stops the flow with it); reason keeps the same text for older readers.
    notice, reason: notice,
  };
}

// What the original PR looks like now compared with the head this flow adopted. A failed read is
// reported as "unknown", never as unchanged.
export async function observeOriginalPR(forge, candidate, { nowIso = new Date().toISOString() } = {}) {
  const base = { number: candidate.number, adoptedHead: candidate.head, checkedAt: nowIso };
  let pr;
  try { pr = await forge.readPR(candidate.number); }
  catch (error) { return { ...base, status: 'unknown', error: String(error?.message ?? error).slice(0, 300) }; }
  const facts = { ...base, url: pr.url ?? null, state: pr.state ?? null, merged: pr.merged === true, head: pr.head ?? null, author: pr.author ?? null };
  if (pr.head === candidate.head) return { ...facts, status: 'unchanged' };
  let commits;
  try { commits = await forge.readPRCommits(candidate.number, { expectedHead: pr.head, expectedCount: pr.commits }); }
  catch (error) { return { ...facts, status: 'moved', commits: null, commitsError: String(error?.message ?? error).slice(0, 300) }; }
  const at = commits.findIndex(commit => commit.sha === candidate.head);
  const added = (at >= 0 ? commits.slice(at + 1) : commits).map(commit => ({ sha: commit.sha, title: firstLine(commit.message) }));
  return { ...facts, status: 'moved', rewritten: at < 0, commits: added.slice(0, LISTED), commitCount: added.length };
}

// Plain text for the merge question and the completion notice (the operator reads it; it is not
// published). Empty when the original PR is known to be unchanged.
export function originalPRDriftText(observation) {
  if (!observation) return '';
  const pr = `original pull request #${observation.number}${observation.url ? ` (${observation.url})` : ''}`;
  if (observation.status === 'unknown') return `Could not check the ${pr} for commits pushed after adoption (${observation.error ?? 'read failed'}; checked ${observation.checkedAt}). Check it before closing it.`;
  if (observation.status !== 'moved') return '';
  const head = `its head moved from the adopted ${short(observation.adoptedHead)} to ${short(observation.head)} (checked ${observation.checkedAt})`;
  const list = observation.commits === null ? ` The new commits could not be listed (${observation.commitsError ?? 'read failed'}).`
    : observation.commits.length ? ` Not included: ${observation.commits.map(c => `${short(c.sha)} ${c.title}`).join('; ')}${observation.commitCount > observation.commits.length ? `; and ${observation.commitCount - observation.commits.length} more` : ''}.` : '';
  const rewritten = observation.rewritten ? ' Its history was rewritten: the adopted head is no longer part of it.' : '';
  return `The ${pr} changed after adoption: ${head}. This flow delivers only the adopted head.${rewritten}${list} Do not close the original PR without handling these commits: adopt it again with the new head, or ask the author to open a new pull request for them.`;
}

export const ORIGINAL_PR_TITLE = 'Review and close the superseded original PR after replacement delivery. If commits were pushed to it after adoption, they are not delivered: do not close it without handling them (adopt it again with the new head, or ask the author).';

// The original-pr obligation after merge: resolved when GitHub already shows the original PR merged
// or closed and nothing was pushed to it after adoption; otherwise pending, with the drift note.
export function originalPRObligation(flowId, observation, fallbackUrl) {
  const id = `${flowId}:original-pr`, evidence = observation?.url ?? fallbackUrl ?? null;
  const drift = originalPRDriftText(observation);
  if (observation?.status === 'unchanged' && (observation.merged || observation.state === 'closed')) {
    return { id, title: 'Superseded original PR', status: 'passed', owner: 'operator', evidence, resolution: observation.merged ? 'GitHub shows the original PR merged' : 'GitHub shows the original PR closed', observation };
  }
  return { id, title: ORIGINAL_PR_TITLE, status: 'pending', owner: 'operator', evidence, ...(drift ? { text: drift } : {}), ...(observation ? { observation } : {}) };
}

// The replacement PR's body names and links the original PR and its author. The login is escaped
// with a broken mention, so the replacement never notifies anyone.
export function replacementBodyNote(originalPR) {
  if (!originalPR?.number) return '';
  const author = originalPR.author ? ` by ${markdownText(originalPR.author, 100)}` : '';
  return `Adopted from pull request #${Number(originalPR.number)}${author}${originalPR.url ? ` (${String(originalPR.url).replace(/[\s<>()]/g, '')})` : ''}: its approved head ${short(originalPR.head)} is delivered here unchanged.\n`;
}

// One neutral comment on the original PR when the replacement is published. No mentions, no
// closing keywords, no model text; the comment lives in the author's own PR thread.
export function originalPRComment({ replacementUrl, replacementNumber, adoptedHead }) {
  const link = replacementUrl ? String(replacementUrl).replace(/[\s<>()]/g, '') : `#${Number(replacementNumber)}`;
  return `This pull request was adopted for delivery. Its commits up to ${short(adoptedHead)} are carried unchanged in a replacement pull request: ${link}. Review and merging happen there. Commits pushed here after adoption are not included automatically; the project's maintainers decide how to handle them.`;
}

// Merge question context for an adopted PR: always says what is known about the original PR.
export function adoptionQuestionContext(flow) {
  if (!flow?.candidate) return '';
  const n = flow.candidate.number, o = flow.originalPRObservation;
  if (!o || o.adoptedHead !== flow.candidate.head) return `Adopted pull request #${n} was not checked for commits pushed after adoption before this question. Check it before closing it.`;
  if (o.status === 'unchanged') return `Adopted pull request #${n}${o.url ? ` (${o.url})` : ''} is unchanged since adoption: head ${short(o.head)}, checked ${o.checkedAt}.`;
  return originalPRDriftText(o);
}
// Completion notice text for an adopted PR whose original moved or could not be checked; '' otherwise.
export function adoptionCompletionNote(flow) {
  if (!flow?.candidate) return '';
  const o = flow.originalPRObservation;
  if (o?.status === 'unchanged' && o.adoptedHead === flow.candidate.head) return '';
  const text = o && o.adoptedHead === flow.candidate.head ? originalPRDriftText(o) : `Could not check the original pull request #${flow.candidate.number} for commits pushed after adoption. Check it before closing it.`;
  return `The adopted head ${short(flow.candidate.head)} was merged. ${text}`;
}

// An adopted pull request that changes the factory's own managed (upgrade-owned) files is refused at
// integration. The operator's notice and the original PR's comment both lead with the rule, the remedy
// and (for the notice) whether the author was told; the file list comes last, within its own budget,
// so a long list can never push the guidance out of a bounded notice. The comment is fixed text with
// escaped file names, like the adoption notice: no mentions, no closing keywords.
export const MANAGED_FILES_BUDGET = 600;
// Whole names while they fit the budget (the first one shortened if it alone is too long), then
// "… and N more" for the rest, counting files not listed at all (more).
export function managedFileList(files, { more = 0, budget = MANAGED_FILES_BUDGET, render = file => file, separator = ', ' } = {}) {
  const shown = [];
  let used = 0;
  for (const file of files) {
    const item = render(file), cost = item.length + (shown.length ? separator.length : 0);
    if (used + cost > budget) { if (!shown.length) { shown.push(`${item.slice(0, Math.max(1, budget - 1))}…`); } break; }
    shown.push(item); used += cost;
  }
  const rest = files.length - shown.length + Number(more || 0);
  return { shown, rest };
}
export function managedFilesComment(files, more = 0) {
  const { shown, rest } = managedFileList(files, { more, render: file => markdownText(file, 300) });
  const list = [...shown.map(file => `- ${file}`), ...(rest ? [`- … and ${rest} more`] : [])].join('\n');
  const body = `This pull request changes files that this project's software factory manages itself, so the factory cannot deliver it. Those files change only through the factory's own updates, not through pull requests. Please drop the changes to them from this pull request; the rest of it can then be considered for delivery again. The project's maintainers decide what happens next.\n\nThe files:\n\n${list}`;
  if (closingReference(body)) throw new Error('managed-files comment would contain a closing reference');
  return body;
}
export function managedFilesNotice({ number, files, more = 0, owned, lock, comment }) {
  const told = comment?.status === 'published' ? 'The pull request author was told in a comment on the pull request.' : comment?.status === 'failed' ? `The comment telling the pull request author could not be published (${String(comment.error ?? '').slice(0, 200)}); tell them directly.` : 'No comment was published on the pull request (repository.adoptionNotice is false); tell the author directly.';
  const { shown, rest } = managedFileList(files, { more });
  return `Adopted pull request #${Number(number)} changes files the factory manages, so it was refused. Rule: the factory's upgrade-owned files (${owned.join(', ')}) change only through a Factotum release (adopt install/update), never through delivered work; policy.allowFactoryEdits permits it, except for ${lock}. Nothing was published or reviewed. Ask the author to drop those changes and push, then adopt the pull request again with its new head. ${told} Files: ${shown.join(', ')}${rest ? ` … and ${rest} more` : ''}.`;
}
