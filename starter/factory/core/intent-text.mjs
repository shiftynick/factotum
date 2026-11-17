// Moving an attempt's dispatch intent between the attempt record and its own record without
// changing a byte of either. JSON.parse followed by JSON.stringify is not the identity on
// valid JSON (escapes, exponents, integers beyond 2^53, spacing, key order), so nothing here
// reserialises: the record text is cut and joined at the positions a scanner finds.
//
// An attempt record text T with a top-level "intent" member is T = A + pre + V + post + B, where
// V is the member's value exactly as written, pre is the key, colon and any spacing (with the
// comma before it when the member is last), and post is the comma after it (when it is not).
//   attempt record without the intent:  A + B
//   intent record:                      {"id":<id>,"intent":V,"restore":{"at":|A|,"pre":…,"post":…,"of":sha256(A + B)}}
// The restore part puts V back exactly where it was, as long as the attempt record is still
// A + B. Once this runtime has rewritten the attempt (or wrote it in the first place), there
// is no earlier text to return to, and the intent goes back where this runtime writes it
// inline: immediately before intentDigest. V is never parsed on either path.
import { createHash } from 'node:crypto';

export class NotLossless extends Error {}
const refuse = reason => { throw new NotLossless(reason); };
const sha = text => createHash('sha256').update(text).digest('hex');
const space = code => code === 32 || code === 10 || code === 13 || code === 9;
const skip = (text, at) => { while (space(text.charCodeAt(at))) at++; return at; };
// The index after the string that opens at `at`.
function endOfString(text, at) {
  if (text.charCodeAt(at) !== 34) refuse('a string was expected');
  for (let from = at + 1; ;) {
    const quote = text.indexOf('"', from); if (quote < 0) refuse('an unterminated string');
    let slashes = 0; for (let back = quote - 1; back > at && text.charCodeAt(back) === 92; back--) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}
// The index after the value that starts at `at`.
function endOfValue(text, at) {
  const first = text.charCodeAt(at);
  if (first === 34) return endOfString(text, at);
  if (first === 123 || first === 91) {
    for (let depth = 0, i = at; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34) i = endOfString(text, i) - 1;
      else if (code === 123 || code === 91) depth++;
      else if ((code === 125 || code === 93) && --depth === 0) return i + 1;
    }
    refuse('an unterminated object or array');
  }
  let end = at; while (end < text.length) { const code = text.charCodeAt(end); if (code === 44 || code === 125 || code === 93 || space(code)) break; end++; }
  if (end === at) refuse('a value was expected');
  return end;
}
// The top-level members of an object text: each key, where its key starts, and its value's span.
function members(text) {
  let at = skip(text, 0); if (text.charCodeAt(at) !== 123) refuse('the record is not an object');
  const found = []; at = skip(text, at + 1);
  if (text.charCodeAt(at) === 125) { if (skip(text, at + 1) !== text.length) refuse('text follows the record'); return { found, close: at }; }
  for (;;) {
    const keyStart = at, keyEnd = endOfString(text, at); let key; try { key = JSON.parse(text.slice(keyStart, keyEnd)); } catch { refuse('a malformed key'); }
    at = skip(text, keyEnd); if (text.charCodeAt(at) !== 58) refuse('a colon was expected');
    const valueStart = skip(text, at + 1), valueEnd = endOfValue(text, valueStart);
    found.push({ key, keyStart, valueStart, valueEnd });
    at = skip(text, valueEnd);
    if (text.charCodeAt(at) === 44) { at = skip(text, at + 1); continue; }
    if (text.charCodeAt(at) !== 125) refuse('a comma or the end of the record was expected');
    if (skip(text, at + 1) !== text.length) refuse('text follows the record');
    return { found, close: at };
  }
}
// Whether a JSON text has an object with two members of the same name, at any depth.
// JSON.parse keeps the last of them and SQLite's JSON functions read the first, so only a
// text without any is read the same by both. The text has one member per string that a
// colon follows; the parsed value has one key per member unless some were merged.
export function hasDuplicateKeys(text, parsed = JSON.parse(text)) {
  let members = 0;
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) !== 34) continue;
    const end = endOfString(text, at); if (text.charCodeAt(skip(text, end)) === 58) members++;
    at = end - 1;
  }
  let keys = 0; const pending = [parsed];
  while (pending.length) {
    const value = pending.pop(); if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const item of value) if (item !== null && typeof item === 'object') pending.push(item); continue; }
    for (const item of Object.values(value)) { keys++; if (item !== null && typeof item === 'object') pending.push(item); }
  }
  return members !== keys;
}
// How many top-level members of a record text are named intent, however the key is spelled.
// JSON.parse keeps the last of several; a record with more than one cannot be cut unambiguously.
export const intentMembers = text => members(text).found.filter(member => member.key === 'intent').length;
const head = id => `{"id":${JSON.stringify(id)},"intent":`;

// The intent record this runtime writes for an intent it holds as a value.
export const intentRecordText = (id, intent) => `${head(id)}${JSON.stringify(intent)}}`;
// The exact text of the intent inside an intent record, and the record's restore part (or null).
export function readIntentRecord(id, record) {
  const start = head(id).length; if (!record.startsWith(head(id))) refuse('the intent record does not begin with its id and intent');
  const end = endOfValue(record, start), tail = record.slice(end);
  if (tail === '}') return { value: record.slice(start, end), restore: null };
  if (!tail.startsWith(',"restore":') || !tail.endsWith('}')) refuse('the intent record has an unknown part after its intent');
  let restore; try { restore = JSON.parse(tail.slice(11, -1)); } catch { refuse('the intent record has a malformed restore part'); }
  if (!(Number.isSafeInteger(restore?.at) && restore.at >= 0 && typeof restore.pre === 'string' && typeof restore.post === 'string' && /^[a-f0-9]{64}$/.test(restore.of ?? ''))) refuse('the intent record has an invalid restore part');
  return { value: record.slice(start, end), restore };
}

// Split an attempt record text that carries its intent inline into the attempt record without
// it and the intent record. Nothing is parsed or rewritten; throws NotLossless when it cannot.
export function separateIntentText(id, text) {
  const { found } = members(text), intents = found.filter(member => member.key === 'intent');
  if (intents.length !== 1) refuse(intents.length ? 'the record has more than one intent field' : 'the record has no intent field');
  const member = intents[0], index = found.indexOf(member), last = index === found.length - 1;
  let from = member.keyStart, to = member.valueEnd;
  if (!last) to = text.indexOf(',', member.valueEnd) + 1;                      // the comma after it goes with it
  else if (index > 0) from = text.lastIndexOf(',', member.keyStart);           // or, for the last member, the comma before it
  const attempt = text.slice(0, from) + text.slice(to);
  const restore = { at: from, pre: text.slice(from, member.valueStart), post: text.slice(member.valueEnd, to), of: sha(attempt) };
  return { attempt, intent: `${head(id)}${text.slice(member.valueStart, member.valueEnd)},"restore":${JSON.stringify(restore)}}` };
}

// The attempt record text with its intent inline again: the original text when the attempt
// record is unchanged since the intent was taken out of it, otherwise the text this runtime
// writes for an inline attempt (intent immediately before intentDigest, or last).
export function inlineIntentText(id, attempt, record) {
  const { value, restore } = readIntentRecord(id, record);
  if (restore && sha(attempt) === restore.of) return attempt.slice(0, restore.at) + restore.pre + value + restore.post + attempt.slice(restore.at);
  const { found, close } = members(attempt);
  if (found.some(member => member.key === 'intent')) refuse('the attempt record already has an intent field');
  const before = found.find(member => member.key === 'intentDigest');
  if (before) return `${attempt.slice(0, before.keyStart)}"intent":${value},${attempt.slice(before.keyStart)}`;
  return `${attempt.slice(0, close)}${found.length ? ',' : ''}"intent":${value}${attempt.slice(close)}`;
}
