import { assert } from '../core/contracts.mjs';
// A task's not-before time: an absolute time with an explicit offset (or Z). null clears it.
export function validNotBefore(value) {
  if (value === null || value === '') return null;
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'notBefore must be a time with an offset, such as 2026-10-26T09:00:00-04:00');
  return value;
}
