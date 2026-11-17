// The kind of a workflow definition in the project's catalog (config.workflows.definitions).
// This module imports nothing, so the catalog compiler and every validator that asks what kind
// a definition is (knowledge upkeep's workflow selector, core/upkeep-config.mjs) share one answer
// and cannot drift apart.
//
// change: builds and merges a candidate. document: writes and merges a document, in its own
// capacity pool. task: carried out by a person or the orchestrator, with no worktree or merge.
export const WORKFLOW_KINDS = Object.freeze(['change', 'document', 'task']);
// The supplied reference graphs (core/catalog.mjs builds them) and the kind each one is.
export const REFERENCE_KINDS = Object.freeze({ 'change.standard': 'change', 'change.document': 'document', 'task.orchestrator': 'task', 'task.operator': 'task' });
export const referenceKind = name => typeof name === 'string' && Object.hasOwn(REFERENCE_KINDS, name) ? REFERENCE_KINDS[name] : undefined;
// A definition's own `kind`, else the kind of the reference it names, else change.
export const definitionKind = definition => definition?.kind ?? referenceKind(definition?.reference) ?? 'change';
