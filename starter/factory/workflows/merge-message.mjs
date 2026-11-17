import { stripVTControlCharacters } from 'node:util';
import { assertNoClosingReferences } from '../adapters/github/index.mjs';
import { stripControls } from '../core/text.mjs';

export const MERGE_TITLE_LIMIT = 100;

// The target's commit for a delivery (merge and squash; GitHub's rebase keeps the candidate's own
// commit messages, which already carry the task title and flow). The subject is the task title
// and the pull request, as GitHub writes squash titles; the flow and task stay in the body for
// tracing. Title text is one line without control characters, at most MERGE_TITLE_LIMIT
// characters, and never a GitHub closing reference (the factory closes tasks itself).
export function mergeCommitText({ title, prNumber, taskId, flowId }) {
  const suffix = Number.isSafeInteger(prNumber) && prNumber > 0 ? ` (#${prNumber})` : '';
  let text = stripControls(stripVTControlCharacters(String(title ?? ''))).replace(/[\t\n\r\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const room = MERGE_TITLE_LIMIT - suffix.length;
  if (text.length > room) text = `${text.slice(0, room - 1).trimEnd()}…`;
  let subject = text ? `${text}${suffix}` : `Factotum delivery${suffix}`;
  try { assertNoClosingReferences(subject); } catch { subject = `Factotum delivery${suffix}`; }
  return { commitTitle: subject, commitMessage: `Approved and independently verified candidate.\n\nTask: ${taskId}\nFactotum flow: ${flowId}` };
}
