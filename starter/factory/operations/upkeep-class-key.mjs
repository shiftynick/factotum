// Class keys for knowledge-upkeep candidates (design 4.2).
//
// A candidate's id is a digest the factory computes from fields a model cannot phrase freely, so
// the same finding observed again has the same key, in any run and on any machine. Nothing here
// reads state or the clock. Whether an anchor is one the factory offered is the validator's check;
// these functions only fix how the key is formed.
import { assert, digest } from '../core/contracts.mjs';
import { LEARNING_STALE_CONDITIONS } from '../core/upkeep-namespace.mjs';

export const CLASS_KEY_VERSION = 1;
export const QUOTE_KINDS = Object.freeze(['docs', 'context']);
export const CAPTURE_FORMS = Object.freeze(['check', 'rule', 'learning']);
// The fixed topic list. Deliberately coarse: two lessons about tests in one directory share a key.
export const CAPTURE_TOPICS = Object.freeze(['procedure', 'test', 'documentation', 'interface-use', 'build', 'data', 'style', 'other']);
// The typed conditions that make a learning stale (11.4).
export const STALE_CONDITIONS = LEARNING_STALE_CONDITIONS;

// Whitespace collapsing for quotes: every run of whitespace becomes one space, and the ends are
// trimmed. The same function is used when a quote is looked for in a file (6.4).
export const collapseWhitespace = text => String(text).replace(/\s+/gu, ' ').trim();
const text = (value, label, max) => { assert(typeof value === 'string' && value.length > 0 && value.length <= max, `${label} must be a non-empty string of at most ${max} characters`); return value; };

// docs, context: the kind, the resolved file path (core/tree-paths.mjs) and the collapsed quote.
export function quoteClassKey({ kind, path, quote }) {
  assert(QUOTE_KINDS.includes(kind), `a quoted candidate is one of ${QUOTE_KINDS.join(', ')}`);
  text(path, 'the resolved file path', 4096); assert(!path.startsWith('/') && !path.split('/').some(part => part === '' || part === '.' || part === '..'), 'the class key takes a resolved repository path');
  const collapsed = collapseWhitespace(text(quote, 'the quote', 100000)); assert(collapsed, 'the quote must contain more than whitespace');
  return digest({ v: CLASS_KEY_VERSION, kind, path, quote: collapsed });
}
// check, rule, learning: the form, an anchor and a topic.
export function captureClassKey({ form, anchor, topic }) {
  assert(CAPTURE_FORMS.includes(form), `a capture candidate is one of ${CAPTURE_FORMS.join(', ')}`);
  assert(CAPTURE_TOPICS.includes(topic), `a capture topic is one of ${CAPTURE_TOPICS.join(', ')}`);
  return digest({ v: CLASS_KEY_VERSION, kind: form, anchor: text(anchor, 'the anchor', 512), topic });
}
// learning-stale: the learning id and the typed condition that fired.
export function staleLearningClassKey({ learningId, condition }) {
  assert(STALE_CONDITIONS.includes(condition), `a stale-learning condition is one of ${STALE_CONDITIONS.join(', ')}`);
  return digest({ v: CLASS_KEY_VERSION, kind: 'learning-stale', learningId: text(learningId, 'the learning id', 128), condition });
}
export function classKey(candidate) {
  if (QUOTE_KINDS.includes(candidate?.kind)) return quoteClassKey(candidate);
  if (CAPTURE_FORMS.includes(candidate?.kind)) return captureClassKey({ form: candidate.kind, anchor: candidate.anchor, topic: candidate.topic });
  if (candidate?.kind === 'learning-stale') return staleLearningClassKey(candidate);
  throw new Error(`no class key is defined for candidate kind ${JSON.stringify(candidate?.kind ?? null)}`);
}
// The directories of the files the signals name, to a depth of two: part of the closed anchor
// list offered for capture candidates. A file at the root has no directory and offers none.
export function anchorDirectories(paths) {
  const found = new Set();
  for (const path of paths) {
    const parts = String(path).split('/').filter(part => part && part !== '.'); parts.pop();
    if (parts.length && !parts.includes('..')) found.add(parts.slice(0, 2).join('/'));
  }
  return [...found].sort();
}
