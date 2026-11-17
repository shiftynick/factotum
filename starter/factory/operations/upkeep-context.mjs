// Knowledge upkeep: governing-context proposals (knowledge-upkeep design 9.4, 10.2, 10.4; slice 6).
// Since slice 7 also a `rule` candidate: a capture candidate in its governing-rule form, one
// condition to add to the existing governing file its `context:<entry>` anchor names (10.3). It is
// accepted by the same operator-only command, into the same `context` task, and every rule below
// applies to it as to a proposal; it adds its text where a proposal replaces a quoted statement.
//
// A proposal is a `finding` row of kind `context`: a statement in a project-owned governing file
// that a merge made false, quoted from the repository, with a replacement of at most 600 characters
// and a one-line reason, both written by the assessment model. It is never an edit. Only the
// operator accepts proposals, in one command that names each one's version and the digest of what
// was displayed (proposalDigest); the task that command writes is in operations/upkeep-tasks.mjs,
// the one upkeep module that writes tasks.
//
// This module writes no task and no file, and starts no process. What it holds:
//   - what the operator is shown and signs: the displayed digest, and why a proposal cannot be
//     accepted (its text fails the text rules, it has no replacement, or an entry that reaches its
//     file is optional, path-mapped, upgrade-owned or no longer configured);
//   - the one notice that says how many proposals are waiting (10.2);
//   - what a returned proposal becomes once its file is read again at the target head (9.4);
//   - which providers a context task may run a model step on (upkeep.context.qualifiedProviders).
//
// Reads: rows by key; the open candidates' own partial index, only when one or two proposals are
// open (to find the oldest); the upkeepOpen meta row. No Git read here: the caller passes a reader.
import { digest } from '../core/contracts.mjs';
import { plainRepositoryPath, safeDocsPath } from '../core/upkeep-namespace.mjs';
import { upkeepSettings } from '../core/upkeep-config.mjs';
import { ASSESSMENT_LIMITS, textRules } from './upkeep-assessment.mjs';
import { collapseWhitespace } from './upkeep-class-key.mjs';
import { findingVersion, isUpkeepCandidate, resolveFindingElsewhereInTransaction } from './upkeep-candidates.mjs';
import { openUpkeepCandidates, upkeepOpen, upkeepRun } from './upkeep-records.mjs';
import { upgradeOwnedPath } from './upkeep-prefilter.mjs';

const DAY = 86400000, iso = ms => new Date(ms).toISOString();
const OBJECT_ID = /^([a-f\d]{40}|[a-f\d]{64})$/;

// ---- What the operator signs (9.4) ----
// The digest of a proposal's stored fields as the console displays them: file, quote, replacement,
// reason, the file's blob id, and the context entries that reach the file. Acceptance recomputes it
// from the stored row and refuses the whole command when it differs from the one displayed.
// A rule's digest covers what the console displays of it: its file, title, text, reason, anchor,
// topic, the file's blob id and the entries that reach the file.
export const proposalDigest = row => row?.kind === 'rule'
  ? digest({ kind: 'rule-proposal', file: row?.file ?? null, anchor: row?.anchor ?? null, topic: row?.topic ?? null, title: row?.title ?? null, text: row?.text ?? null, reason: row?.reason ?? null, blob: row?.blob ?? null, entries: Array.isArray(row?.entries) ? [...row.entries] : [] })
  : digest({ kind: 'context-proposal', file: row?.file ?? null, quote: row?.quote ?? null, replacement: row?.replacement ?? null, reason: row?.reason ?? null, blob: row?.blob ?? null, entries: Array.isArray(row?.entries) ? [...row.entries] : [] });
export const isGoverningProposal = row => isUpkeepCandidate(row) && ['context', 'rule'].includes(row.kind);
// A rule is added within the context task's budget of 12 changed lines per accepted proposal; two
// are kept for a blank line and a heading.
export const RULE_MAX_LINES = 10;

// Why a stored proposal's model-written text may not reach a later agent: the text rules of 6.5,
// confusables included, applied to the replacement and to the reason (the slice 6 precondition of
// docs/changes/upkeep-confusables.md). Applied again here because a row may predate a rule.
export function proposalTextProblems(row) {
  const problems = [];
  if (row?.kind === 'rule') {
    for (const [field, max] of [['title', ASSESSMENT_LIMITS.title], ['text', ASSESSMENT_LIMITS.captureText]]) { const written = typeof row?.[field] === 'string' && row[field] ? textRules(row[field], max) : { refused: 'empty' }; if (written.refused) problems.push(`its ${field} fails the text rules (${written.refused})`); }
    if (typeof row?.text === 'string' && row.text.split('\n').length > RULE_MAX_LINES) problems.push(`its text is ${row.text.split('\n').length} lines; a rule added by a context task is at most ${RULE_MAX_LINES}`);
    if (typeof row?.reason === 'string' && row.reason) { const reason = textRules(row.reason, ASSESSMENT_LIMITS.reason); if (reason.refused) problems.push(`its reason fails the text rules (${reason.refused})`); }
    return problems;
  }
  if (typeof row?.replacement !== 'string' || !row.replacement.trim()) problems.push('it has no replacement text, so there is no exact edit to accept (a docs candidate whose file became governing is shown here as a proposal without one)');
  else { const written = textRules(row.replacement, ASSESSMENT_LIMITS.replacement); if (written.refused) problems.push(`its replacement fails the text rules (${written.refused})`); }
  if (typeof row?.reason === 'string' && row.reason) { const reason = textRules(row.reason, ASSESSMENT_LIMITS.reason); if (reason.refused) problems.push(`its reason fails the text rules (${reason.refused})`); }
  return problems;
}
// Why the context entries that reach a proposal's file cannot be named in governingEdits under this
// configuration ([] when they can). Every entry that reaches the file is named, because the
// governing boundary compares every configured entry: an entry left out would refuse the change.
// Each must be configured, required, unmapped, plainly named and project-owned (the governance-edit
// rules), so that every step of the flow receives it.
export function proposalEntryProblems(row, contextConfig, owned) {
  const ids = Array.isArray(row?.entries) ? row.entries.filter(id => typeof id === 'string' && id) : [], problems = [];
  if (!ids.length) return ['no configured context entry is recorded for its file'];
  for (const id of ids) {
    const entry = (contextConfig?.files ?? []).find(item => item?.id === id);
    if (!entry) { problems.push(`context entry ${id} is no longer configured`); continue; }
    if (!plainRepositoryPath(entry.path)) problems.push(`context entry ${id}'s path is not a plain repository path`);
    if (entry.required !== true) problems.push(`context entry ${id} is optional (required is not true), so a step could run without it; make it required first (config update)`);
    if (entry.paths !== undefined) problems.push(`context entry ${id} has a paths mapping, so it is delivered only when the scope selects it; remove the mapping first (config update)`);
    if (!owned) problems.push('the upgrade-owned paths cannot be read');
    else if (upgradeOwnedPath(owned, entry.path) || upgradeOwnedPath(owned, row.file ?? '')) problems.push(`context entry ${id} is upstream-owned factory instruction; it changes only through a factory release`);
  }
  return problems;
}
// Everything that keeps one stored proposal from being accepted now, apart from its status and
// version: [] when it can be accepted.
export function proposalProblems(row, { config, owned }) {
  if (!isGoverningProposal(row)) return [`finding ${row?.id} is not a governing-context proposal or a rule`];
  const problems = [];
  // A rule belongs in the governing file its anchor names: anchored anywhere else, there is no file
  // to add it to, and it is the operator's to write by an ordinary task with governingEdits.
  if (row.kind === 'rule') {
    const entry = typeof row.anchor === 'string' && row.anchor.startsWith('context:') ? row.anchor.slice(8) : null;
    if (!entry) return [`it is anchored to ${JSON.stringify(String(row.anchor ?? '').slice(0, 80))}, not to a governing-context entry, so there is no governing file to add it to; decline it, or write the rule by an ordinary task you approve (governingEdits)`];
    if (!Array.isArray(row.entries) || !row.entries.includes(entry)) problems.push(`the governing file its anchor (context entry ${entry}) reaches was not recorded when it was raised`);
  }
  if (!safeDocsPath(row.file)) problems.push('its file name is outside the filename policy');
  if (!OBJECT_ID.test(row.blob ?? '')) problems.push('the version of its file it was validated against is not recorded');
  if (row.kind === 'context' && (typeof row.quote !== 'string' || !collapseWhitespace(row.quote))) problems.push('it quotes nothing');
  return [...problems, ...proposalTextProblems(row), ...proposalEntryProblems(row, config?.context, owned)];
}
// A candidate as Health shows it, with any model-written text that fails the text rules withheld
// (length is not judged here; a row bounds its own text). `withheld` names what was held back.
// A capture candidate's title is model-written too (slice 7); a docs or context row's title is the
// file and the quote, repository text.
const WRITTEN_FIELDS = Object.freeze(['reason', 'replacement', 'text']), CAPTURE_KINDS = Object.freeze(['check', 'rule', 'learning']);
export function withheldText(view) {
  const withheld = [...WRITTEN_FIELDS, ...(CAPTURE_KINDS.includes(view?.kind) ? ['title'] : [])].filter(field => typeof view?.[field] === 'string' && view[field] && textRules(view[field], Number.MAX_SAFE_INTEGER).refused);
  return withheld.length ? { ...view, ...Object.fromEntries(withheld.map(field => [field, null])), withheld } : { ...view, withheld: [] };
}
// What Health shows beside a proposal: its digest, and why it cannot be accepted.
export const proposalAcceptanceView = (row, { config, owned }) => ({ digest: proposalDigest(row), problems: proposalProblems(row, { config, owned }) });

// ---- Providers (slice 6 precondition) ----
// The provider instruction suppression a context task relies on is verified per host by a live
// check (docs/qualification/provider-instructions.md) that this release cannot run. The operator
// records a passed check in upkeep.context.qualifiedProviders; a context task runs a model step on
// no other provider. Empty by default.
export const CONTEXT_QUALIFICATION_DOC = 'docs/qualification/provider-instructions.md';
export function unqualifiedProviders(config, routes) {
  const qualified = new Set(upkeepSettings(config ?? {}).context.qualifiedProviders), found = new Set();
  for (const route of Object.values(routes ?? {})) for (const provider of [route?.provider, ...(route?.allowFallback && route?.fallback ? [route.fallback.provider ?? route.provider] : [])]) if (!qualified.has(provider)) found.add(String(provider));
  return [...found].sort();
}
// The refusal names the remedy too (dev.91, O5): it is what the task, the queue and Health show.
export const contextProviderRemedy = providers => `To start it, run that checklist for ${providers.join(' and ')} on this host and, once it passes, add ${providers.length === 1 ? 'it' : 'them'} to upkeep.context.qualifiedProviders (config update, operator only); or route the task's model steps to a listed provider (task.models)`;
export const contextProviderRefusal = (taskId, providers) => `task ${taskId} changes governing files from accepted context proposals, and ${providers.join(' and ')} ${providers.length === 1 ? 'is' : 'are'} not in upkeep.context.qualifiedProviders: no model step of a context task runs on a provider until the operator records that its instruction-loading check passed on this host (${CONTEXT_QUALIFICATION_DOC}). ${contextProviderRemedy(providers)}`;

// ---- The waiting notice (10.2) ----
// At most one notice says how many proposals are waiting, raised when three are open or the oldest
// has waited seven days. Nothing polls: it is judged when upkeep records proposals, when a person
// acts on one, and when one expires or returns. It is closed when none is waiting.
export const CONTEXT_WAITING_NOTICE = 'upkeep-context-waiting', CONTEXT_WAITING_COUNT = 3, CONTEXT_WAITING_AGE_MS = 7 * DAY;
export function contextWaitingNoticeInTransaction(store, { nowMs = Date.now() } = {}) {
  const count = upkeepOpen(store).candidates.context, notice = store.get('inbox', CONTEXT_WAITING_NOTICE), open = notice?.status === 'open';
  if (!count) {
    if (open) { store.put('inbox', { ...notice, status: 'resolved', resolvedAt: iso(nowMs), resolvedReason: 'no governing-context proposal is waiting', version: notice.version + 1 }); store.event('inbox.resolved', { inboxId: CONTEXT_WAITING_NOTICE }); }
    return null;
  }
  // The oldest is read only when the count alone does not decide, through the open candidates' own index.
  let oldest = null;
  if (count < CONTEXT_WAITING_COUNT) { try { oldest = openUpkeepCandidates(store).filter(row => isUpkeepCandidate(row) && row.kind === 'context' && row.status === 'unapproved').map(row => Date.parse(row.openedAt ?? row.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null; } catch { oldest = null; } }
  const due = count >= CONTEXT_WAITING_COUNT || oldest !== null && nowMs - oldest >= CONTEXT_WAITING_AGE_MS;
  if (!due && !open) return null;
  const context = `${count} governing-context ${count === 1 ? 'proposal is' : 'proposals are'} waiting for you in Health (Knowledge upkeep). Only you can accept one; accepting a batch makes one task, approved by you, that changes those governing files.`;
  if (open && notice.context === context) return notice;
  const item = { id: CONTEXT_WAITING_NOTICE, kind: 'notice', status: 'open', version: (notice?.version ?? 0) + 1, role: 'operator', operatorAckOnly: true, title: 'Governing-context proposals are waiting', context, count, createdAt: open ? notice.createdAt : iso(nowMs), updatedAt: iso(nowMs) };
  store.put('inbox', item); store.event(open ? 'inbox.updated' : 'inbox.created', { inboxId: CONTEXT_WAITING_NOTICE, count });
  return item;
}

// ---- A returned proposal, read again (9.4) ----
// When a context task's flow ends because a declared file changed under it (stale, base-moved) or
// for a drain, its proposals return to waiting at a new version, and the operator sees the current
// text before accepting again. `reader.governing(path)` reads the file at the target head the
// factory last recorded ({ status: 'governing', blob, text } or another status); without a reader
// nothing more is done and the stale pin is caught again before the next flow's first model step.
// The quote still there: the row records the file's current blob (a new version). The quote gone,
// with the head shown to contain the source merge or the file unchanged since: resolved elsewhere.
export function revalidateProposalsInTransaction(store, findingIds, { reader, tasks, nowMs = Date.now() }) {
  if (!reader) return [];
  const changed = [];
  for (const id of findingIds) {
    const row = store.get('finding', id);
    if (!isGoverningProposal(row) || row.status !== 'unapproved') continue;
    const at = reader.governing(row.file);
    if (at?.status !== 'governing') continue;
    // A rule quotes nothing: it is read again at the file's current version.
    if (row.kind === 'rule' || collapseWhitespace(at.text).includes(collapseWhitespace(row.quote ?? ''))) {
      if (at.blob !== row.blob) { const next = { ...row, blob: at.blob, version: findingVersion(row) + 1, revalidated: { head: reader.head, previousBlob: row.blob ?? null, at: iso(nowMs) } }; store.put('finding', next); store.event('finding.revalidated', { id, head: reader.head }); changed.push(next); }
    } else if (at.blob === row.blob || OBJECT_ID.test(upkeepRun(store, (row.sourceFlows ?? [])[0] ?? '')?.mergeCommit ?? '') && reader.reaches(reader.head, upkeepRun(store, row.sourceFlows[0]).mergeCommit)) changed.push(resolveFindingElsewhereInTransaction(store, { id, reason: 'statement-gone', evidence: `The quoted statement is no longer in ${row.file} at ${reader.head}`, tasks, nowMs }).finding);
  }
  return changed;
}
