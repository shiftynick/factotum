// The refusal for an answer to a question that is no longer the one the answerer read (dev.85, I4).
//
// Every refusal keeps its first words, "stale or resolved question", which consumers match (the
// console's explanation, handling guides and scripts), and then says which case it is: the question
// was already answered (with the answer and who gave it), is otherwise resolved (superseded,
// expired, withdrawn), or is still open but changed since it was read (a new version or subject),
// or the answer named a version the question does not have (dev.86).
// It names no time: the receipt records when it was refused, and History and the Inbox show when
// the question was answered.
import { assert } from './contracts.mjs';

export const STALE_QUESTION = 'stale or resolved question';
const label = item => { const choice = Array.isArray(item.choices) ? item.choices.find(row => row?.id === item.answer) : null; return typeof choice?.label === 'string' && choice.label ? choice.label : String(item.answer ?? ''); };
// Which version mismatch it is (dev.86, J1). Versions only grow, so only a version older than the
// current one was read from the question before it changed. A newer version, or a value that is
// not a version number (versions start at 1), was never read from it, and the wording says so.
function versionMismatch(given, current) {
  if (given === undefined || given === null) return `no version was given (it is at version ${current})`;
  if (!Number.isSafeInteger(given) || given < 1) return `the version given (${JSON.stringify(given)?.slice(0, 40) ?? typeof given}) is not a version number (it is at version ${current})`;
  if (Number.isSafeInteger(current) && given < current) return `it changed since it was read (version ${given}, now ${current})`;
  return `the version given (${given}) is not the current one (${current}); it has never had that version`;
}
export function staleQuestionReason(item, read = {}) {
  const { version, subjectDigest } = read;
  if (item.status === 'answered') {
    const by = item.relay?.relayedBy ? `${item.relay.relayedBy} (relayed)` : item.answeredBy ?? null;
    return `${STALE_QUESTION}: it was already answered “${label(item)}”${by ? ` by the ${by}` : ''}; this answer was not applied`;
  }
  if (item.status !== 'open') return `${STALE_QUESTION}: it is ${item.withdrawal ? 'withdrawn' : item.status} and takes no answer; this answer was not applied`;
  if (Object.hasOwn(read, 'version') && item.version !== version) return `${STALE_QUESTION}: ${versionMismatch(version, item.version)}; read it again before answering`;
  if (Object.hasOwn(read, 'subjectDigest') && item.subjectDigest !== subjectDigest) return `${STALE_QUESTION}: what it asks about changed since it was read; read it again before answering`;
  return null;
}
// Refuses unless the question is open at exactly the version (and subject) the answerer read.
export function assertCurrentQuestion(item, read) {
  const reason = staleQuestionReason(item, read);
  assert(!reason, reason ?? STALE_QUESTION);
}
