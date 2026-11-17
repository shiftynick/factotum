// The reserved `upkeep:` task namespace and the task marker (knowledge-upkeep design, 7.2 and 7.4).
// This module imports nothing, so every route that can create a task, the configuration checks
// and the GitHub adapter can share one predicate.
//
// Upkeep tasks are made by the factory only (operations/upkeep-tasks.mjs, slice 5 part B): an id in
// the namespace cannot be created through any other task-creating route, the `upkeep` field (the
// marker) cannot be put on a task by hand, and a task whose marker names a kind this release does
// not enforce is refused at admission and at commit, integration, publication and merge. This
// release enforces all five kinds, `docs` (slice 5 part A), `context` (slice 6), `check` and
// `learning-add` (slice 7) and `learning-retire` (slice 8): a marker of any of them that is not well
// formed is refused at the same points, and a well-formed one has its candidate checked at the four
// operations (workflows/upkeep-enforcement.mjs).
export const UPKEEP_NAMESPACE = 'upkeep:';
// Task ids, source namespaces and the GitHub id prefix are ASCII (core/contracts.mjs id), so
// lower-casing is ASCII lower-casing: the same as SQLite's lower(), which the collision lookup
// uses (core/records.mjs records_open_task_lower_id).
export const asciiLower = value => String(value).replace(/[A-Z]/g, letter => letter.toLowerCase());
// One predicate everywhere: an id, a source namespace or an id prefix is reserved when,
// lower-cased, it starts with `upkeep:`. `Upkeep:x` and `UPKEEP:x` are reserved as `upkeep:x` is.
export const inUpkeepNamespace = value => typeof value === 'string' && asciiLower(value).startsWith(UPKEEP_NAMESPACE);

// The task kinds the design defines (7.4), and those whose limits this release enforces on the
// candidate. A later release adds a kind here only together with its enforcement.
export const UPKEEP_TASK_KINDS = Object.freeze(['docs', 'context', 'check', 'learning-add', 'learning-retire']);
export const ENFORCED_UPKEEP_KINDS = Object.freeze(['docs', 'context', 'check', 'learning-add', 'learning-retire']);
export const hasUpkeepMarker = task => Boolean(task) && typeof task === 'object' && Object.hasOwn(task, 'upkeep') && task.upkeep !== undefined;
const shown = value => JSON.stringify(typeof value === 'string' ? value.slice(0, 60) : value === undefined ? null : typeof value);

// ---- The docs marker (7.2, 7.4) ----
// What the candidate check of a docs task reads from its marker. The factory's creation path writes
// it (operations/upkeep-tasks.mjs); a marker that cannot be read is refused rather than guessed at.
//   files:  [{ path, blob }]: the declared files, each with the Git blob id it was validated at.
//           They are the task's `paths`, exactly and in any order.
//   limits: { maxFiles, maxChangedLines }: the limits in force when the task was created. The
//           check applies these or the current configuration's, whichever is tighter.
export const DOCS_MARKER_MAX_FILES = 3;
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A repository path as Git stores it in a tree: non-empty components that are not `.` or `..`,
// no leading or trailing slash, no NUL or backslash. A declared file is named exactly this way.
export const plainRepositoryPath = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('\0') && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
// The conservative filename policy for anything upkeep names as a file (review of 292d317, P2-1):
// a plain repository path of at most 16 components, each of ASCII letters, digits and `._+-`, not
// starting with `-`, at most 255 characters, and at most 300 in all. No space, no control
// character, no newline, nothing outside ASCII: a file name is repository text, and one that could
// read as a sentence never reaches a criterion, a brief field or a pull request. A doc whose name
// fails it cannot be corrected by upkeep; that is ordinary work.
const SAFE_COMPONENT = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,254}$/;
export const safeDocsPath = value => plainRepositoryPath(value) && value.split('/').length <= 16 && value.split('/').every(part => SAFE_COMPONENT.test(part));
export function docsMarkerProblems(task) {
  const marker = task?.upkeep, problems = [];
  if (!plainObject(marker)) return ['the marker is not an object'];
  if (marker.kind !== 'docs') return ['the marker is not of kind docs'];
  const files = marker.files;
  if (!Array.isArray(files) || !files.length || files.length > DOCS_MARKER_MAX_FILES) problems.push(`files must list 1 to ${DOCS_MARKER_MAX_FILES} declared files`);
  else {
    if (!files.every(file => plainObject(file) && safeDocsPath(file.path) && typeof file.blob === 'string' && /^([a-f\d]{40}|[a-f\d]{64})$/.test(file.blob))) problems.push('each declared file needs a plain repository path within the filename policy (ASCII letters, digits and ._+- only) and the Git blob id it was validated at');
    else if (new Set(files.map(file => file.path)).size !== files.length) problems.push('a declared file is listed twice');
    else {
      const paths = Array.isArray(task.paths) ? task.paths : null;
      if (!paths || paths.length !== files.length || !files.every(file => paths.includes(file.path))) problems.push("the task's paths are not exactly its declared files");
    }
  }
  const limits = marker.limits;
  if (!plainObject(limits) || !['maxFiles', 'maxChangedLines'].every(name => Number.isSafeInteger(limits[name]) && limits[name] > 0)) problems.push('limits must give maxFiles and maxChangedLines as whole numbers above zero');
  return problems;
}

// ---- The context marker (7.4, 9.4; slice 6) ----
// What the candidate check of a context task reads from its marker, written by the operator's
// acceptance of governing-context proposals (operations/upkeep-tasks.mjs, createContextTaskInTransaction).
//   files:      [{ path, blob, entries }]: the declared files, each the resolved path of a
//               project-owned configured governing file, the Git blob id it was last validated at,
//               and the context entry ids that reach it. The task's `paths` are exactly these paths,
//               and its `governingEdits` exactly the entry ids they name.
//   candidates: [{ id, version }]: the accepted proposals, one per evidence item.
//   limits:     { maxFiles, maxChangedLines }: the files the proposals name, and 12 changed lines
//               per accepted proposal (P3). The check applies these or the computed ones, whichever
//               is tighter.
export const CONTEXT_MARKER_MAX_FILES = 8, CONTEXT_MARKER_MAX_PROPOSALS = 10, CONTEXT_LINES_PER_PROPOSAL = 12;
const ENTRY_ID = /^[^\0-\x1f\x7f]{1,128}$/;
export function contextMarkerProblems(task) {
  const marker = task?.upkeep, problems = [];
  if (!plainObject(marker)) return ['the marker is not an object'];
  if (marker.kind !== 'context') return ['the marker is not of kind context'];
  const files = marker.files, candidates = marker.candidates;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > CONTEXT_MARKER_MAX_PROPOSALS || !candidates.every(row => plainObject(row) && typeof row.id === 'string' && row.id && Number.isSafeInteger(row.version) && row.version > 0) || new Set(candidates.map(row => row.id)).size !== candidates.length) problems.push(`candidates must list 1 to ${CONTEXT_MARKER_MAX_PROPOSALS} distinct accepted proposals with their versions`);
  if (!Array.isArray(files) || !files.length || files.length > CONTEXT_MARKER_MAX_FILES) problems.push(`files must list 1 to ${CONTEXT_MARKER_MAX_FILES} declared governing files`);
  else if (!files.every(file => plainObject(file) && safeDocsPath(file.path) && typeof file.blob === 'string' && /^([a-f\d]{40}|[a-f\d]{64})$/.test(file.blob) && Array.isArray(file.entries) && file.entries.length > 0 && file.entries.every(id => typeof id === 'string' && ENTRY_ID.test(id)) && new Set(file.entries).size === file.entries.length)) problems.push('each declared file needs a plain repository path within the filename policy, the Git blob id it was last validated at, and the context entries that reach it');
  else if (new Set(files.map(file => file.path)).size !== files.length) problems.push('a declared file is listed twice');
  else {
    const paths = Array.isArray(task.paths) ? task.paths : null, entries = files.flatMap(file => file.entries), named = Array.isArray(task.governingEdits) ? task.governingEdits : null;
    if (!paths || paths.length !== files.length || !files.every(file => paths.includes(file.path))) problems.push("the task's paths are not exactly its declared files");
    if (new Set(entries).size !== entries.length) problems.push('a context entry is named for two declared files');
    // The approval the operator gave (governingEdits) and what the check enforces name the same entries.
    if (!named || named.length !== entries.length || !entries.every(id => named.includes(id))) problems.push("the task's governingEdits are not exactly the context entries its declared files name");
  }
  const limits = marker.limits;
  if (!plainObject(limits) || !['maxFiles', 'maxChangedLines'].every(name => Number.isSafeInteger(limits[name]) && limits[name] > 0)) problems.push('limits must give maxFiles and maxChangedLines as whole numbers above zero');
  return problems;
}
// ---- The check marker (7.4, 10.3; slice 7) ----
// What the candidate check of a check task reads from its marker, written by finding.accept of a
// check candidate (operations/upkeep-tasks.mjs, createCaptureTaskInTransaction).
//   files:      [{ path, blob, mode, checks }]: one or two declared files, each the script of a
//               configured fast check as the factory identified it from the check's argv
//               (operations/upkeep-capture.mjs), with the Git blob id and the mode (ordinary or
//               executable) it was offered at, and the ids of the fast checks it is the script of.
//               The task's `paths` are exactly these paths.
//   candidates: [{ id, version }]: the one accepted check candidate.
//   limits:     { maxFiles, maxChangedLines }: at most 2 files and 80 changed lines (P3). The check
//               applies these or the fixed ones, whichever is tighter.
export const CHECK_MARKER_MAX_FILES = 2, CHECK_MAX_CHANGED_LINES = 80;
export const CHECK_SCRIPT_MODES = Object.freeze(['100644', '100755']);
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const oneCandidate = candidates => Array.isArray(candidates) && candidates.length === 1 && plainObject(candidates[0]) && typeof candidates[0].id === 'string' && candidates[0].id && Number.isSafeInteger(candidates[0].version) && candidates[0].version > 0;
export function checkMarkerProblems(task) {
  const marker = task?.upkeep, problems = [];
  if (!plainObject(marker)) return ['the marker is not an object'];
  if (marker.kind !== 'check') return ['the marker is not of kind check'];
  if (!oneCandidate(marker.candidates)) problems.push('candidates must name the one accepted check candidate with its version');
  const files = marker.files;
  if (!Array.isArray(files) || !files.length || files.length > CHECK_MARKER_MAX_FILES) problems.push(`files must list 1 to ${CHECK_MARKER_MAX_FILES} declared fast-check scripts`);
  else if (!files.every(file => plainObject(file) && safeDocsPath(file.path) && typeof file.blob === 'string' && /^([a-f\d]{40}|[a-f\d]{64})$/.test(file.blob) && CHECK_SCRIPT_MODES.includes(file.mode) && Array.isArray(file.checks) && file.checks.length > 0 && file.checks.length <= 8 && file.checks.every(id => typeof id === 'string' && CHECK_ID.test(id)))) problems.push('each declared file needs a plain repository path within the filename policy, the Git blob id and the mode (100644 or 100755) it was offered at, and the fast checks it is the script of');
  else if (new Set(files.map(file => file.path)).size !== files.length) problems.push('a declared file is listed twice');
  else {
    const paths = Array.isArray(task.paths) ? task.paths : null;
    if (!paths || paths.length !== files.length || !files.every(file => paths.includes(file.path))) problems.push("the task's paths are not exactly its declared files");
  }
  if (task.governingEdits !== undefined) problems.push('a check task names no governing edit');
  const limits = marker.limits;
  if (!plainObject(limits) || !['maxFiles', 'maxChangedLines'].every(name => Number.isSafeInteger(limits[name]) && limits[name] > 0)) problems.push('limits must give maxFiles and maxChangedLines as whole numbers above zero');
  return problems;
}

// ---- Approving a check task (operator decision after the review of 6f83d54) ----
// A check script is code the factory runs on every later candidate, so a check task is approved as a
// governing edit is: by the operator alone, acting directly (never by delegation, an instruction or a
// grant, on either schema), bound to its exact revision and to the declared scripts with the blob and
// mode each was offered at. task.approve records `checkScriptsApproval`; admission, every step and
// the four operations require it to be current.
export const isCheckTask = task => Boolean(task) && typeof task === 'object' && task.upkeep?.kind === 'check';
export const checkApprovalFiles = task => (Array.isArray(task?.upkeep?.files) ? task.upkeep.files : []).map(file => ({ path: file?.path ?? null, blob: file?.blob ?? null, mode: file?.mode ?? null }));
export const checkScriptsApproved = task => isCheckTask(task) && task.approvedRevision === task.revision
  && task.checkScriptsApproval?.revision === task.revision && task.checkScriptsApproval?.approvalVersion === task.approvalVersion
  && JSON.stringify(task.checkScriptsApproval?.files ?? null) === JSON.stringify(checkApprovalFiles(task));
export const checkApprovalRefusal = (task, where) => `${where}: task ${task.id} changes fast-check scripts the factory runs on every candidate; its current approval is not the operator's own approval of revision ${String(task.revision).slice(0, 12)} and its declared scripts. Only the operator approves a check task, directly (task.approve, or finding.accept with approve: true), never by delegation or a grant`;
export function assertCheckScriptsApproved(task, where) { if (isCheckTask(task) && !checkScriptsApproved(task)) throw new Error(checkApprovalRefusal(task, where)); }

// ---- The learning-add marker (7.4, 11.1; slice 7) ----
// What the candidate check of a learning-add task reads from its marker, written by finding.accept
// of a learning candidate.
//   learning:   { dir, path, id, title, paths, kind, enforced_by, last_verified, retire_when, body }:
//               the learnings directory as configured when it was accepted, the one file to add
//               (`<dir>/<id>.md`), and every field the file must hold: the frontmatter and the body.
//               The task's `paths` are exactly [path].
//   candidates: [{ id, version }]: the one accepted learning candidate.
//   limits:     { maxChars }: the whole file, frontmatter and title included, at most 1,500 (Q3).
// The file format, the frontmatter schema and its rendering are LEARNING_FORMAT below; the same
// functions parse a delivered file (workflows/upkeep-enforcement.mjs).
export const LEARNING_MAX_CHARS = 1500, LEARNING_MAX_PATHS = 8;
export const LEARNING_TOPICS = Object.freeze(['procedure', 'test', 'documentation', 'interface-use', 'build', 'data', 'style', 'other']);
export const LEARNING_FIELDS = Object.freeze(['id', 'title', 'paths', 'kind', 'enforced_by', 'last_verified', 'retire_when']);
export const LEARNING_ID = /^learning-[a-f0-9]{12}$/;
// A learning's path glob: a repository-relative glob of ASCII letters, digits, `._+-`, `/`, `*` and
// `?`, no empty, `.` or `..` component, no leading slash.
export const learningGlob = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._+*?\/-]+$/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const ENFORCED_BY = /^(?:none|check:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|context:[^\0-\x20\x7f]{1,128})$/;
// retire_when accepts only none or the three typed forms of 11.4.
export const RETIRE_WHEN = value => value === 'none' || typeof value === 'string' && (/^path-absent:/.test(value) && learningGlob(value.slice(12)) || /^file-present:/.test(value) && safeDocsPath(value.slice(13)) || /^check-present:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const singleLine = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f\u2028\u2029]/u.test(value);
// Why a learning's fields are not ones the store accepts ([] when they are).
export function learningFieldProblems(fields) {
  const problems = [];
  if (!plainObject(fields)) return ['the learning is not an object'];
  if (typeof fields.id !== 'string' || !LEARNING_ID.test(fields.id)) problems.push('id must be learning- and 12 lowercase hexadecimal digits');
  if (!singleLine(fields.title, 120)) problems.push('title must be one line of at most 120 characters');
  if (!Array.isArray(fields.paths) || !fields.paths.length || fields.paths.length > LEARNING_MAX_PATHS || !fields.paths.every(learningGlob) || new Set(fields.paths).size !== fields.paths.length) problems.push(`paths must list 1 to ${LEARNING_MAX_PATHS} distinct repository-relative globs`);
  if (!LEARNING_TOPICS.includes(fields.kind)) problems.push(`kind must be one of ${LEARNING_TOPICS.join(', ')}`);
  if (typeof fields.enforced_by !== 'string' || !ENFORCED_BY.test(fields.enforced_by)) problems.push('enforced_by must be none, check:<fast check id> or context:<context entry id>');
  if (!validDate(fields.last_verified)) problems.push('last_verified must be a date, YYYY-MM-DD');
  if (!RETIRE_WHEN(fields.retire_when)) problems.push('retire_when must be none, path-absent:<glob>, file-present:<path> or check-present:<fast check id>');
  if (typeof fields.body !== 'string' || !fields.body.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(fields.body) || fields.body.split('\n').includes('---')) problems.push('the body must be non-empty text without control characters or a --- line');
  return problems;
}
// The one way a learning file is written: frontmatter of exactly the seven fields, in this order,
// one per line, the title and the paths as JSON (which YAML reads as the same values), then a blank
// line and the body, ending with one newline.
export function renderLearning(fields) {
  return ['---', `id: ${fields.id}`, `title: ${JSON.stringify(fields.title)}`, `paths: ${JSON.stringify(fields.paths)}`, `kind: ${fields.kind}`, `enforced_by: ${fields.enforced_by}`, `last_verified: ${fields.last_verified}`, `retire_when: ${fields.retire_when}`, '---', '', `${fields.body.replace(/\n+$/u, '')}`, ''].join('\n');
}
// A delivered learning file read back: { fields } or { problems }. Strict: the layout renderLearning
// writes and nothing else (no carriage return, no other key, no other order), with one allowance
// (dev.92, P3): the paths list may carry the spaces of ordinary JSON or YAML flow-list writing, such
// as `["src/a/**", "test/a.test.mjs"]` or `[ "src/a/**" ]`. That is safe because a glob holds no
// space or quote (learningGlob): removing the spaces from such a line gives exactly the line
// renderLearning writes, and every other line must still match it byte for byte. A file the factory
// adds is still judged against the exact accepted text (workflows/upkeep-enforcement.mjs); the
// allowance is for files written by hand. A line that does not parse names the expected form.
export const LEARNING_PATHS_EXAMPLE = 'paths: ["src/example/**", "test/example.test.mjs"]';
const pathsLineCanonical = (raw, paths) => raw.replace(/ /g, '') === JSON.stringify(paths);
export function parseLearning(text) {
  if (typeof text !== 'string') return { problems: ['the file is not text'] };
  if (text.includes('\r')) return { problems: ['the file holds a carriage return'] };
  const lines = text.split('\n');
  if (lines[0] !== '---' || lines[8] !== '---' || lines[9] !== '' || lines.length < 12 || lines.at(-1) !== '') return { problems: ['the file does not have the learning layout: a --- line, the seven frontmatter fields, a --- line, a blank line, the body and a final newline'] };
  const fields = {}, problems = [];
  for (const [at, name] of LEARNING_FIELDS.entries()) {
    const line = lines[at + 1], prefix = `${name}: `;
    if (!line.startsWith(prefix)) { problems.push(`frontmatter line ${at + 2} is not ${name}`); continue; }
    const raw = line.slice(prefix.length);
    if (name === 'title') { try { fields[name] = JSON.parse(raw); } catch { problems.push('title is not written as one JSON string, such as title: "One line that names the lesson"'); } }
    else if (name === 'paths') { try { fields[name] = JSON.parse(raw); } catch { problems.push(`paths is not written as a JSON list of quoted globs, such as ${LEARNING_PATHS_EXAMPLE}`); } }
    else fields[name] = raw;
  }
  fields.body = lines.slice(10, -1).join('\n');
  if (problems.length) return { problems };
  const invalid = learningFieldProblems(fields);
  if (invalid.length) return { problems: invalid };
  const expected = renderLearning(fields).split('\n'), spaced = lines[3] !== expected[3] && pathsLineCanonical(lines[3].slice('paths: '.length), fields.paths);
  const differs = expected.findIndex((line, at) => line !== lines[at] && !(at === 3 && spaced));
  if (differs < 0 && expected.length !== lines.length) return { problems: ['the file is not written exactly in the learning layout: it ends with more than one newline after the body; end it with exactly one'] };
  if (differs >= 0) return { problems: [`the file is not written exactly in the learning layout: line ${differs + 1} should read ${JSON.stringify(expected[differs])}${differs === 3 ? ` (a JSON list of quoted globs, such as ${LEARNING_PATHS_EXAMPLE})` : ''}`] };
  return { fields };
}
export const learningChars = text => [...String(text)].length;
export function learningMarkerProblems(task) {
  const marker = task?.upkeep, problems = [];
  if (!plainObject(marker)) return ['the marker is not an object'];
  if (marker.kind !== 'learning-add') return ['the marker is not of kind learning-add'];
  if (!oneCandidate(marker.candidates)) problems.push('candidates must name the one accepted learning candidate with its version');
  const learning = marker.learning;
  if (!plainObject(learning)) problems.push('learning must describe the one file to add');
  else {
    problems.push(...learningFieldProblems(learning));
    if (!plainRepositoryPath(learning.dir) || learning.path !== `${learning.dir}/${learning.id}.md` || !safeDocsPath(learning.path)) problems.push('the learning path must be <learnings directory>/<id>.md, within the filename policy');
    else if (!problems.length && learningChars(renderLearning(learning)) > LEARNING_MAX_CHARS) problems.push(`the learning file would be longer than ${LEARNING_MAX_CHARS} characters`);
    const paths = Array.isArray(task.paths) ? task.paths : null;
    if (!paths || paths.length !== 1 || paths[0] !== learning.path) problems.push("the task's paths are not exactly the one learning file");
  }
  if (task.governingEdits !== undefined) problems.push('a learning task names no governing edit');
  const limits = marker.limits;
  if (!plainObject(limits) || !Number.isSafeInteger(limits.maxChars) || limits.maxChars <= 0) problems.push('limits must give maxChars as a whole number above zero');
  return problems;
}
// ---- The learning-retire marker (7.4, 11.4; slice 8) ----
// What the candidate check of a learning-retire task reads from its marker, written by finding.accept
// of a learning-stale candidate (operations/upkeep-tasks.mjs, createCaptureTaskInTransaction).
//   learning:   { dir, path, id, blob }: the learnings directory as configured when it was accepted,
//               the one file to delete (`<dir>/<id>.md`) and the Git blob id it had at the target
//               head then: only that exact content may be deleted (P1: a retirement deletes; it
//               never edits). The task's `paths` are exactly [path].
//   condition:  the typed condition that fired (11.4).
//   candidates: [{ id, version }]: the one accepted stale-learning candidate.
//   limits:     { maxFiles: 1 }.
// The typed conditions that make a learning stale (11.4): three built in, three a learning names.
export const LEARNING_STALE_CONDITIONS = Object.freeze(['paths', 'enforcement', 'unused', 'path-absent', 'file-present', 'check-present']);
export function learningRetireMarkerProblems(task) {
  const marker = task?.upkeep, problems = [];
  if (!plainObject(marker)) return ['the marker is not an object'];
  if (marker.kind !== 'learning-retire') return ['the marker is not of kind learning-retire'];
  if (!oneCandidate(marker.candidates)) problems.push('candidates must name the one accepted stale-learning candidate with its version');
  if (!LEARNING_STALE_CONDITIONS.includes(marker.condition)) problems.push(`condition must be one of ${LEARNING_STALE_CONDITIONS.join(', ')}`);
  const learning = marker.learning;
  if (!plainObject(learning)) problems.push('learning must name the one file to delete');
  else {
    if (typeof learning.id !== 'string' || !LEARNING_ID.test(learning.id)) problems.push('the learning id must be learning- and 12 lowercase hexadecimal digits');
    else if (!plainRepositoryPath(learning.dir) || learning.path !== `${learning.dir}/${learning.id}.md` || !safeDocsPath(learning.path)) problems.push('the learning path must be <learnings directory>/<id>.md, within the filename policy');
    if (typeof learning.blob !== 'string' || !/^([a-f\d]{40}|[a-f\d]{64})$/.test(learning.blob)) problems.push('the learning needs the Git blob id it had when the candidate was accepted');
    const paths = Array.isArray(task.paths) ? task.paths : null;
    if (!paths || paths.length !== 1 || paths[0] !== learning.path) problems.push("the task's paths are not exactly the one learning file");
  }
  if (task.governingEdits !== undefined) problems.push('a learning-retire task names no governing edit');
  const limits = marker.limits;
  if (!plainObject(limits) || limits.maxFiles !== 1) problems.push('limits must give maxFiles 1');
  return problems;
}
// The problems of a marker of an enforced kind ([] when it can be read).
const MARKER_PROBLEMS = { docs: docsMarkerProblems, context: contextMarkerProblems, check: checkMarkerProblems, 'learning-add': learningMarkerProblems, 'learning-retire': learningRetireMarkerProblems };
export const markerProblems = task => MARKER_PROBLEMS[task?.upkeep?.kind]?.(task) ?? [];

// Why a task may not proceed on account of its marker; null for a task without one, and for a
// well-formed marker whose kind this release enforces. `enforced` is a parameter only so that the
// rule can be tested against a list other than this release's.
export function upkeepMarkerRefusal(task, { enforced = ENFORCED_UPKEEP_KINDS } = {}) {
  if (!hasUpkeepMarker(task)) return null;
  const kind = task.upkeep && typeof task.upkeep === 'object' && !Array.isArray(task.upkeep) ? task.upkeep.kind : undefined;
  if (typeof kind === 'string' && enforced.includes(kind)) {
    const problems = markerProblems(task);
    if (!problems.length) return null;
    return `task ${task.id} carries an upkeep marker of kind ${shown(kind)} that this release cannot read (${problems.join('; ')}); the task cannot be admitted, committed, integrated, published or merged`;
  }
  return `task ${task.id} carries an upkeep marker of kind ${shown(kind)}, which this release does not enforce${enforced.length ? ` (enforced: ${enforced.join(', ')})` : ' (it enforces no upkeep task kind)'}; the task cannot be admitted, committed, integrated, published or merged`;
}
export function assertUpkeepEnforced(task, point, options) {
  const refusal = upkeepMarkerRefusal(task, options);
  if (refusal) throw Object.assign(new Error(`${point}: ${refusal}`), { refusal: { kind: 'upkeep-marker', upkeepKind: typeof task?.upkeep?.kind === 'string' ? task.upkeep.kind : null } });
}

// The two configuration values that give imported tasks their id prefix, with the name of the
// setting each comes from.
export function configuredTaskNamespaces(config = {}) {
  const found = [];
  if ((config.sourceSync?.type ?? 'github') === 'command' && typeof config.sourceSync?.namespace === 'string') found.push({ setting: 'sourceSync.namespace', value: config.sourceSync.namespace });
  if (typeof config.repository?.issueProfile?.dependencyIdPrefix === 'string') found.push({ setting: 'repository.issueProfile.dependencyIdPrefix', value: config.repository.issueProfile.dependencyIdPrefix });
  return found;
}
export const reservedNamespaceMessage = (setting, value) => `${setting} ${JSON.stringify(value)} is in the reserved upkeep: task namespace (compared without regard to case), which only the factory writes; choose another namespace (config update) and synchronize the source again`;
// Why this configuration cannot be commissioned or synchronized: each setting in the namespace.
export const reservedNamespaceReasons = config => configuredTaskNamespaces(config).filter(row => inUpkeepNamespace(row.value)).map(row => reservedNamespaceMessage(row.setting, row.value));
export class ReservedNamespaceError extends Error { constructor(message) { super(message); this.name = 'ReservedNamespaceError'; this.reservedNamespace = true; } }
export function assertNoReservedNamespace(config) {
  const reasons = reservedNamespaceReasons(config);
  if (reasons.length) throw new ReservedNamespaceError(reasons.join('; '));
}
