// The operator-facing notice for an enforcement refusal (dev.90, N1).
//
// A step that a candidate boundary refused failed its flow, and the flow's notice said only "Change
// workflow failed; inspect retained attempt evidence": the boundary's precise message stayed in the
// attempt's action-result.json. An action now gives such a refusal a `notice` (workflows/dispatch.mjs
// runAction; the failed-flow notice and status --flow's `flow.failure` carry it, core/engine.mjs
// attemptNotice), and a refusal found before review gives one to its stop (workflows/actions.mjs).
// It says what was refused and what to do, then quotes the refusal itself, last, so a cut keeps the
// remedy.
//
// Every enforcement boundary tags its refusal with one field, `refusal: {kind, ...facts}`, and this
// reads only that field (review of 8441ff4, P2-2: it used to read scattered fields and missed the
// docs-conflict refusals). The kinds and the boundaries that set them:
//   governing-file            operations/governance-edit.mjs assertGoverningBoundary: files [{id, path, approved}], approvedEdits
//   provider-config           operations/provider-config.mjs assertProviderConfigBoundary: paths
//   provider-config-link      operations/provider-config.mjs: problem 'cycle' (with its link) or 'limit'
//   upkeep-limits             workflows/upkeep-enforcement.mjs assertUpkeepCandidate: upkeepKind, files, ending
//   upkeep-conflict           workflows/dispatch.mjs workspace.integrate: upkeepKind, files, ending 'base-moved'
//   upkeep-merge-in-progress  workflows/dispatch.mjs workspace.commit: upkeepKind
//   upkeep-marker             core/upkeep-namespace.mjs assertUpkeepEnforced: upkeepKind
// The facts are factory state (entry IDs and paths, file paths from verified trees, kinds); nothing
// from a model's output is interpreted. Remedy wording lives here, in one place.
export const NOTICE_MAX = 2000;
export const REFUSAL_KINDS = Object.freeze(['governing-file', 'provider-config', 'provider-config-link', 'upkeep-limits', 'upkeep-conflict', 'upkeep-merge-in-progress', 'upkeep-marker']);
const list = (items, max = 5) => items.slice(0, max).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '');
const plural = (items, one, many) => items.length === 1 ? one : many;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
const reopen = kind => `To try again, reopen a candidate from Health (finding.reopen)${kind === 'docs' ? ' and the factory makes a new follow-up from it against the current target' : ''}; or make the correction yourself.`;

// `where` is the operation or point that refused (workspace.commit, `review (before review)`);
// `stopped` is true when the refusal stops the flow (it can be replanned) rather than failing it.
// Returns '' for an error without a known `refusal`.
export function refusalNotice(error, { task, where, stopped = false } = {}) {
  const r = error && typeof error === 'object' ? error.refusal : null;
  if (!r || typeof r !== 'object' || !REFUSAL_KINDS.includes(r.kind) || typeof error.message !== 'string') return '';
  const id = task?.id ?? '(unknown task)', at = where ?? 'the factory';
  const again = stopped ? 'replan the flow (flow.replan) with a note that' : 'start the task again (task.restart) with a note that';
  const upkeepKind = typeof r.upkeepKind === 'string' ? r.upkeepKind : typeof task?.upkeep?.kind === 'string' ? task.upkeep.kind : 'unknown';
  const upkeepTask = `knowledge-upkeep task ${id} (kind ${upkeepKind})`;
  let lead = '';
  if (r.kind === 'governing-file') {
    const files = (Array.isArray(r.files) ? r.files : []).filter(row => row && typeof row.id === 'string');
    const approved = strings(r.approvedEdits);
    const shape = files.filter(row => row.approved === true), unnamed = files.filter(row => row.approved !== true);
    const shown = rows => list(rows.map(row => typeof row.path === 'string' ? `${row.id} (${row.path})` : row.id));
    const paths = rows => list(rows.map(row => typeof row.path === 'string' ? row.path : row.id));
    const parts = [];
    if (unnamed.length) parts.push(`The candidate of task ${id} changes governing ${plural(unnamed, 'file', 'files')} ${shown(unnamed)}, which ${approved.length ? `the task is not approved to change (its approved governingEdits name only ${list(approved)})` : 'the task is not approved to change (it names no governingEdits)'}, so ${at} refused it. To make this change, put a task revision that names ${list(unnamed.map(row => row.id))} in governingEdits, with ${paths(unnamed)} in its paths, approve that revision directly as the operator (task.approve), and start the task again (task.restart). Otherwise undo the change: ${again} ${paths(unnamed)} must stay unchanged.`);
    if (shape.length) parts.push(`${unnamed.length ? 'It also changes' : `The candidate of task ${id} changes`} ${shown(shape)} in a way an approval never covers (a link, a move or a mode change; only the file's content may change), so ${at} refused it. Undo that part of the change: ${again} ${plural(shape, 'the file keeps', 'the files keep')} ${plural(shape, 'its', 'their')} path and mode.`);
    lead = parts.join(' ');
  } else if (r.kind === 'provider-config') {
    const paths = strings(r.paths);
    lead = `The candidate of task ${id} changes provider configuration (${list(paths) || 'paths not named'}) that the task does not declare in its paths, so ${at} refused it. Provider CLIs can load such files as configuration, skills, hooks or instructions. To make this change, put a task revision whose paths name ${plural(paths, 'it', 'them')}, approve it, and start the task again (task.restart). Otherwise undo the change: ${again} ${plural(paths, 'it', 'they')} must stay unchanged.`;
  } else if (r.kind === 'provider-config-link') {
    const what = r.problem === 'cycle' ? `a link in its provider configuration that leads back to a folder already on its way${typeof r.link === 'string' && r.link ? ` (${r.link})` : ''}` : 'more links through its provider configuration than the factory follows';
    lead = `The candidate of task ${id} has ${what}, so what a provider would load through them cannot be checked, and ${at} refused it. Nothing was delivered. Remove or shorten those links: ${again} the provider configuration must have no link cycle and only short chains of links.`;
  } else if (r.kind === 'upkeep-limits') {
    const files = strings(r.files);
    lead = ['stale', 'base-moved'].includes(r.ending)
      ? `The candidate of ${upkeepTask} was refused at ${at} because a file it declared${files.length ? ` (${list(files)})` : ''} is no longer the version its candidates were validated against: the target changed it. Nothing was delivered. Its candidates return to waiting (a third return expires them); nothing is needed from you.`
      : `The candidate of ${upkeepTask} is outside what its kind permits${files.length ? ` (${list(files)})` : ''}, so ${at} refused it. Nothing was delivered. When its flow fails, its candidates are recorded as failed and its task is closed. ${reopen(upkeepKind)}`;
  } else if (r.kind === 'upkeep-conflict') {
    const files = strings(r.files);
    lead = `The integration of ${upkeepTask} with the target conflicted${files.length ? ` in ${list(files)}` : ''}: the target changed the declared file after the candidate was made. An upkeep follow-up is ended, not repaired, so ${at} refused it and undid the merge. Nothing was delivered. Its candidates return to waiting (a third return expires them); nothing is needed from you. Do not resolve the conflict by hand.`;
  } else if (r.kind === 'upkeep-merge-in-progress') {
    lead = `The worktree of ${upkeepTask} has a merge in progress that the factory did not start (an upkeep follow-up whose integration conflicts is ended, not repaired), so ${at} refused to commit it. Nothing was delivered. When its flow fails, its candidates are recorded as failed and its task is closed. Do not resolve a follow-up's conflict by hand. ${reopen(upkeepKind)}`;
  } else if (r.kind === 'upkeep-marker') {
    lead = `Task ${id} carries a knowledge-upkeep marker of kind ${upkeepKind} that this release cannot enforce, so ${at} refused it. Nothing was delivered. Abandon its flow and close the task, or upgrade to a release that enforces that kind.`;
  }
  const notice = `${lead} Refusal: ${error.message}`;
  return notice.length > NOTICE_MAX ? `${notice.slice(0, NOTICE_MAX - 1)}…` : notice;
}

// Gives an enforcement refusal its notice, once; any other error is returned unchanged.
export function withRefusalNotice(error, options) {
  if (error && typeof error === 'object' && typeof error.notice !== 'string') {
    const notice = refusalNotice(error, options);
    if (notice) error.notice = notice;
  }
  return error;
}
