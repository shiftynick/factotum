// Runs the record-layout migration or its reverse on a state and kills this process,
// uncatchably, at a chosen point. Used by tests/state-layout.test.mjs.
//   layout-crash.mjs <stateDir> <migrate|inline> <point> <chunkBytes>
// point: write:N   at the N-th record write (inside a transaction)
//        inside:N  at the end of the N-th transaction's work, before it commits
//        after:N   once the N-th transaction has committed
//        count     no kill: run to the end and print how many transactions ran
import { Store } from '../../starter/factory/core/store.mjs';
import { inlineAttemptIntents, migrateStateLayout } from '../../starter/factory/operations/state-layout.mjs';
const [stateDir, operation, point, chunkBytes] = process.argv.slice(2), [where, at] = point.split(':'), target = Number(at);
const die = () => { process.kill(process.pid, 'SIGKILL'); for (;;); };
const store = new Store(stateDir), write = store.write.bind(store), tx = store.tx.bind(store);
let writes = 0, transactions = 0;
store.write = (...args) => { if (where === 'write' && ++writes === target) die(); return write(...args); };
store.tx = work => { const n = ++transactions, value = tx(() => { const result = work(); if (where === 'inside' && n === target) die(); return result; }); if (where === 'after' && n === target) die(); return value; };
(operation === 'inline' ? inlineAttemptIntents : migrateStateLayout)(store, { chunkBytes: Number(chunkBytes) });
store.close();
if (where === 'count') console.log(transactions);
