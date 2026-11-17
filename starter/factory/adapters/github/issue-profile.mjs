import { validNotBefore } from '../../operations/not-before.mjs';
import { inUpkeepNamespace, reservedNamespaceMessage } from '../../core/upkeep-namespace.mjs';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const unique = values => [...new Set(values)];
export function validateIssueProfile(profile = {}) {
  assert(profile && typeof profile === 'object' && !Array.isArray(profile), 'issue profile must be an object');
  for (const key of ['blockedLabels','forbiddenLabels','ordinaryLabels','strictLabels','followupLabels','importBlockedLabels']) if (profile[key] !== undefined) assert(strings(profile[key]), `invalid issue profile ${key}`);
  for (const key of ['acceptanceHeadings','postMergeHeadings','pathsHeadings']) if (profile[key] !== undefined) assert(strings(profile[key]) && profile[key].every(x => x.trim()), `invalid issue profile ${key}`);
  if (profile.maxDependencies !== undefined) assert(Number.isSafeInteger(profile.maxDependencies) && profile.maxDependencies > 0 && profile.maxDependencies <= 100, 'maxDependencies must be 1..100');
  if (profile.dependencyIdPrefix !== undefined) assert(typeof profile.dependencyIdPrefix === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*:$/.test(profile.dependencyIdPrefix), 'dependencyIdPrefix must be a task namespace ending in colon');
  // Compared lower-cased, unlike the format above: Upkeep: and UPKEEP: are reserved too.
  assert(!inUpkeepNamespace(profile.dependencyIdPrefix), reservedNamespaceMessage('repository.issueProfile.dependencyIdPrefix', profile.dependencyIdPrefix));
  if (profile.lifecycle) {
    assert(profile.lifecycle.labels && typeof profile.lifecycle.labels === 'object', 'lifecycle label mapping required');
    for (const [phase, label] of Object.entries(profile.lifecycle.labels)) assert(['admitted','review','completed','stopped'].includes(phase) && typeof label === 'string' && label.length > 0, 'invalid lifecycle phase/label');
    if (profile.lifecycle.approvalLabel !== undefined) assert(typeof profile.lifecycle.approvalLabel === 'string' && profile.lifecycle.approvalLabel.length, 'invalid lifecycle approval label');
    const labels = [...Object.values(profile.lifecycle.labels),profile.lifecycle.approvalLabel].filter(Boolean);
    assert(!labels.some(label => [...(profile.blockedLabels ?? []), ...(profile.forbiddenLabels ?? []),...(profile.ordinaryLabels ?? []),...(profile.strictLabels ?? [])].includes(label)), 'managed lifecycle labels cannot also block, forbid, or classify risk');
  }
  for (const key of ['areaPrefix','categoryPrefix']) if (profile[key] !== undefined) assert(typeof profile[key] === 'string' && profile[key].length, `invalid ${key}`);
  return profile;
}
export function dependencyNumber(value, profile = {}) {
  const text=String(value),prefix=profile.dependencyIdPrefix??'github:';
  const numeric=text.startsWith(prefix)?text.slice(prefix.length):text.replace(/^#/, '');
  return /^\d+$/.test(numeric)?Number(numeric):null;
}
function section(body, headings) {
  const accepted = new Set((headings ?? []).map(h => h.trim().toLowerCase()));
  if (!accepted.size) return [];
  const lines = body.split(/\r?\n/); let collecting = false, fence = false; const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/) ?? line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
    if (heading) { collecting = accepted.has(heading[1].trim().replace(/:$/, '').toLowerCase()); continue; }
    if (!collecting) continue;
    const bullet = line.match(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}
export function mapIssue(raw, profile = {}, parent = null) {
  validateIssueProfile(profile);
  const body = raw.body ?? '', labels = (raw.labels ?? []).map(l => typeof l === 'string' ? l : l.name).sort();
  assert(typeof body === 'string' && body.length <= 2_000_000, 'issue body must be bounded text');
  const encoded = body.match(/```factotum-task\s*\n([\s\S]*?)```/);
  let brief = {};
  // A lightweight brief may give a one-line `doneWhen` instead of an acceptance list.
  if (encoded) { brief = JSON.parse(encoded[1]); if (brief.acceptance === undefined && brief.doneWhen !== undefined) brief.acceptance = Array.isArray(brief.doneWhen) ? brief.doneWhen : [brief.doneWhen]; assert(brief.version === 1 && strings(brief.acceptance) && brief.acceptance.length > 0, 'invalid factotum task brief'); assert(brief.workflow === undefined || typeof brief.workflow === 'string' && brief.workflow, 'invalid brief workflow'); validNotBefore(brief.notBefore ?? null); }
  const acceptance = brief.acceptance ?? section(body, profile.acceptanceHeadings);
  const postMerge = brief.postMerge ?? section(body, profile.postMergeHeadings);
  const paths = brief.paths ?? section(body, profile.pathsHeadings).map(x => x.replace(/^`|`$/g, ''));
  const dependencies = [...(brief.dependencies ?? [])];
  if (profile.proseDependencies === true) for (const match of body.matchAll(/\b(?:depends on|blocked by|waits on)\s*:?\s*((?:#\d+(?:\s*(?:,|and)\s*)?)+)/gi)) for (const n of match[1].matchAll(/#(\d+)/g)) dependencies.push(Number(n[1]));
  const selected = (key, prefix) => brief[key] ?? (prefix ? labels.find(label => label.startsWith(prefix))?.slice(prefix.length) : undefined);
  const area = selected('area', profile.areaPrefix), category = selected('category', profile.categoryPrefix);
  const grouping = profile.requireParent ? parent : brief.parent ?? parent;
  const blockedReasons = labels.filter(label => [...(profile.blockedLabels ?? []), ...(profile.forbiddenLabels ?? [])].includes(label));
  if (profile.requireParent && !grouping) blockedReasons.push('parent grouping required');
  if (profile.requireParent && brief.parent != null && brief.parent !== parent) blockedReasons.push('declared parent differs from GitHub grouping');
  if (profile.requireArea && !area) blockedReasons.push('area required');
  const risk = labels.some(l => (profile.strictLabels ?? []).includes(l)) ? 'strict' : brief.risk ?? (labels.some(l => (profile.ordinaryLabels ?? []).includes(l)) ? 'ordinary' : 'strict');
  for (const [key, value] of Object.entries({ acceptance, postMerge, paths })) assert(strings(value), `invalid issue ${key}`);
  assert(Array.isArray(dependencies) && dependencies.every(d => (Number.isSafeInteger(d) && d > 0) || (typeof d === 'string' && d.length)), 'invalid issue dependencies');
  assert(['ordinary','strict'].includes(risk), 'invalid issue risk');
  if (grouping != null) assert(Number.isSafeInteger(grouping) && grouping > 0, 'invalid parent grouping');
  for (const [key, value] of Object.entries({ area, category })) if (value !== undefined) assert(typeof value === 'string' && value.length, `invalid issue ${key}`);
  const managed = profile.lifecycle ? [...Object.values(profile.lifecycle.labels), profile.lifecycle.approvalLabel].filter(Boolean) : [];
  return { title: raw.title, body, labels, ...(brief.workflow ? { workflow: brief.workflow } : {}), ...(brief.notBefore ? { notBefore: brief.notBefore } : {}), ...(Array.isArray(brief.inputs) ? { inputs: brief.inputs } : {}), ...(brief.originalRequest !== undefined ? { originalRequest: brief.originalRequest } : {}), revisionLabels: labels.filter(l => !managed.includes(l)), acceptance, dependencies: unique(dependencies), postMerge, paths, risk, outcome: brief.outcome ?? raw.title,
    ...(area !== undefined ? { area } : {}), ...(category !== undefined ? { category } : {}), parent: grouping ?? null, blocked: blockedReasons.length > 0, blockedReasons,
    followup: { parent: grouping ?? null, labels: unique([...(profile.followupLabels ?? []), ...(area && profile.areaPrefix ? [profile.areaPrefix + area] : [])]).filter(l => l !== profile.lifecycle?.approvalLabel) } };
}
