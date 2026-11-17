// Untrusted text (model output, check output) shown to people or passed to models: no terminal
// escape sequences (7-bit ESC [ … and 8-bit CSI U+009B), no C0 controls other than tab, newline
// and carriage return, no DEL and no C1 controls (U+0080–U+009F, which terminals also obey).
export function stripControls(value) {
  return String(value ?? '').replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
// Untrusted text shown as one bounded line or paragraph: controls stripped, trimmed, cut with an ellipsis.
export function boundedText(value, max) {
  const text = stripControls(value).trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
