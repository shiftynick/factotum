import { createHash } from 'node:crypto';

// Names of the private refs an adopted pull request's `candidate` step fetches into the project
// checkout: refs/factotum/adoptions/<key>-<attempt> for the PR head and
// refs/factotum/adoption-targets/<key>-<attempt> for the target, where <key> identifies the flow
// and <attempt> the attempt. Every attempt fetches into names of its own, so cleaning up the refs
// of attempts that have ended can never touch a ref a later attempt of the same flow (after a
// replan, say) is using, whatever the timing. Names without the attempt part were written by
// earlier releases and by earlier development builds; they are still recognised for cleanup.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ADOPTION_REFS_KIND = 'adoptionRefs';
export const ADOPTION_REF = /^refs\/factotum\/adoption(?:s|-targets)\/[0-9a-f]{32}(?:-[0-9a-f]{16})?$/;
export function adoptionRefNames({ projectId, flowId, attemptId }) {
  const key = hash({ projectId, flowId }).slice(0, 32), suffix = attemptId ? `-${hash({ attemptId }).slice(0, 16)}` : '';
  return { head: `refs/factotum/adoptions/${key}${suffix}`, target: `refs/factotum/adoption-targets/${key}${suffix}` };
}
