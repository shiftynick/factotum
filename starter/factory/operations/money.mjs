import { assert, digest } from '../core/contracts.mjs';
const amount = n => { assert(Number.isSafeInteger(n) && n >= 0, 'money must be nonnegative safe integer micro-units'); return n; };
export function reserveMoney(store, { id, flowId, ceilingMicros, capMicros, capability }) {
  amount(ceilingMicros); amount(capMicros);
  assert(ceilingMicros === 0 || capability?.enforceableCeiling === true, 'paid execution disabled without adapter-enforced ceiling');
  return store.tx(() => {
    assert(!store.meta('moneyHold', false), 'monetary overrun hold requires explicit reconciliation');
    const inputDigest = digest({ flowId, ceilingMicros, capMicros }); const old = store.get('money', id);
    if (old) { assert(old.inputDigest === inputDigest, 'reservation identity reused'); return old; }
    const rows = store.all('money'), spent = rows.reduce((n, r) => n + (r.actualMicros ?? 0), 0), held = rows.reduce((n, r) => n + (['reserved', 'unknown'].includes(r.status) ? r.ceilingMicros : 0), 0);
    assert(Number.isSafeInteger(spent + held + ceilingMicros) && spent + held + ceilingMicros <= capMicros, 'monetary cap exhausted');
    const row = { id, flowId, ceilingMicros, inputDigest, status: 'reserved', actualMicros: null }; store.put('money', row); store.event('money.reserved', { id, flowId, ceilingMicros }); return row;
  });
}
export function settleMoney(store, id, actualMicros) {
  return store.tx(() => {
    const row = store.need('money', id);
    if (actualMicros === null) { assert(['reserved', 'unknown'].includes(row.status), 'settled reservation cannot become unknown'); row.status = 'unknown'; }
    else {
      amount(actualMicros);
      if (row.status === 'settled' || row.status === 'overrun') { assert(row.actualMicros === actualMicros, 'conflicting monetary settlement'); return row; }
      row.actualMicros = actualMicros; row.status = actualMicros > row.ceilingMicros ? 'overrun' : 'settled';
      if (row.status === 'overrun') { store.setMeta('paused', true); store.setMeta('moneyHold', true); }
    }
    store.put('money', row); store.event('money.settled', { id, actualMicros, status: row.status }); return row;
  });
}
