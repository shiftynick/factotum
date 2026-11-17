import { openPrivateSQLite } from '../core/sqlite.mjs';
import { assert, digest, now } from '../core/contracts.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const money = n => assert(Number.isSafeInteger(n) && n >= 0, 'integer micro-unit amount required');

// Shared by projects. An unresolved reservation blocks further paid dispatch even
// after its process dies: process death is not a provider billing receipt.
export class SpendingLedger {
  constructor(path) {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = openPrivateSQLite(path, 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS spending(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  all() { return this.db.prepare('SELECT data FROM spending').all().map(row => JSON.parse(row.data)); }
  get(id) { const row = this.db.prepare('SELECT data FROM spending WHERE id=?').get(id); return row && JSON.parse(row.data); }
  put(row) { this.db.prepare('INSERT INTO spending VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id, JSON.stringify(row)); return row; }
  reserve({ id, projectId, flowId, budgetId, ceilingMicros, capMicros, authorityDigest, enforcement, allocation, reviewRequired = false, attemptId }) {
    money(ceilingMicros); money(capMicros);
    assert(id && projectId && flowId && budgetId && authorityDigest && enforcement?.enforceableCeiling === true && enforcement.qualificationDigest, 'qualified adapter ceiling and scoped authority required');
    return this.tx(() => {
      if (allocation) { assert(typeof allocation.id === 'string' && allocation.id, 'allocation identity required'); money(allocation.capMicros); }
      const input = { id, projectId, flowId, budgetId, ceilingMicros, capMicros, authorityDigest, reviewRequired, ...(attemptId ? {attemptId} : {}), ...(allocation ? {allocation} : {}) }, inputDigest = digest(input), old = this.get(id);
      if (old) { assert(old.inputDigest === inputDigest, 'spending identity changed'); return { ...old, existing: true }; }
      const rows = this.all();
      assert(!rows.some(row => ['reserved', 'unknown', 'overrun', 'evidence-hold', 'awaiting-review'].includes(row.status)), 'global paid execution held by unsettled spending');
      const spent = rows.filter(row => row.projectId === projectId && row.budgetId === budgetId).reduce((sum, row) => sum + row.actualMicros, 0);
      assert(Number.isSafeInteger(spent + ceilingMicros) && spent + ceilingMicros <= capMicros, 'approved budget exhausted');
      if (allocation) { const used = rows.filter(row => row.projectId === projectId && row.budgetId === budgetId && row.allocation?.id === allocation.id).reduce((sum,row)=>sum+row.actualMicros,0); assert(Number.isSafeInteger(used+ceilingMicros) && used+ceilingMicros<=allocation.capMicros, 'approved allocation exhausted'); }
      return this.put({ ...input, inputDigest, enforcementDigest: digest(enforcement), status: 'reserved', actualMicros: null, reservedAt: now() });
    });
  }
  settle(id, { actualMicros, receiptDigest }) {
    return this.tx(() => {
      const row = this.get(id); assert(row, 'unknown spending reservation');
      if (actualMicros === null) { assert(['reserved', 'unknown'].includes(row.status), 'settled cost cannot become unknown'); return this.put({ ...row, status: 'unknown' }); }
      money(actualMicros); assert(typeof receiptDigest === 'string' && receiptDigest.length, 'independent cost receipt required');
      if (['settled', 'overrun', 'awaiting-review'].includes(row.status)) { assert(row.actualMicros === actualMicros && row.receiptDigest === receiptDigest, 'conflicting settlement'); return row; }
      return this.put({ ...row, actualMicros, receiptDigest, settledAt: now(), status: actualMicros > row.ceilingMicros ? 'overrun' : row.reviewRequired ? 'awaiting-review' : 'settled' });
    });
  }
  confirmReview(id, evidenceDigest) {
    assert(typeof evidenceDigest === 'string' && evidenceDigest, 'independent reviewed evidence required');
    return this.tx(() => { const row=this.get(id);assert(row && ['awaiting-review','settled'].includes(row.status), 'settled cost awaiting review required');if(row.status==='settled'&&row.reviewDigest)return row;return this.put({...row,status:'settled',reviewDigest:evidenceDigest,reviewedAt:row.reviewedAt??now()}); });
  }
  reconcile(id, {actualMicros,receiptDigest,reviewDigest,note,newCapMicros}) {
    money(actualMicros);assert(receiptDigest&&reviewDigest&&typeof note==='string'&&note.trim(),'operator cost receipt, reviewed evidence and reason required');
    return this.tx(()=>{
      const row=this.get(id);assert(row,'unknown spending reservation');
      const proofDigest=digest({actualMicros,receiptDigest,reviewDigest,note,...(newCapMicros===undefined?{}:{newCapMicros})});
      if(row.reconciliationDigest){assert(row.reconciliationDigest===proofDigest,'reconciliation proof changed');return row;}
      if(row.actualMicros!==null)assert(row.actualMicros===actualMicros,'known spending cannot be rewritten');
      const overrun=actualMicros>row.ceilingMicros;
      if(overrun){money(newCapMicros);const total=this.all().filter(other=>other.projectId===row.projectId&&other.budgetId===row.budgetId&&other.id!==id).reduce((sum,other)=>sum+(other.actualMicros??other.ceilingMicros),0);assert(Number.isSafeInteger(total+actualMicros)&&newCapMicros>=total+actualMicros,'overrun recovery needs explicit sufficient increased budget');}
      return this.put({...row,status:'settled',actualMicros,receiptDigest,reviewDigest,overrun,...(newCapMicros===undefined?{}:{recoveryCapMicros:newCapMicros}),reconciliationDigest:proofDigest,reconciledAt:now(),reconciliationNote:note});
    });
  }
}
export function spendingSnapshot(config, projectId) {
  if (!config.spending?.enabled) return { enabled:false, actualMicros:0, heldMicros:0, scope:'explicit paid integration adapters only' };
  const path=config.spending.coordinatorPath;
  if (!path || !existsSync(path)) return {enabled:true,available:false,reason:'Shared spending ledger not yet observed'};
  let db;
  try {
    db=new DatabaseSync(path,{readOnly:true});const rows=db.prepare('SELECT data FROM spending').all().map(row=>JSON.parse(row.data)), own=rows.filter(row=>row.projectId===projectId);
    return {enabled:true,available:true,actualMicros:own.reduce((sum,row)=>sum+(row.actualMicros??0),0),heldMicros:own.filter(row=>['reserved','unknown'].includes(row.status)).reduce((sum,row)=>sum+row.ceilingMicros,0),globalHold:rows.some(row=>['reserved','unknown','overrun','evidence-hold','awaiting-review'].includes(row.status)),reservations:own,scope:'explicit paid integration adapters only; subscription CLI estimates are separate'};
  } catch {return {enabled:true,available:false,reason:'Shared spending ledger unavailable; paid authority remains unproven'};}
  finally {db?.close();}
}
