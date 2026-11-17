import { openPrivateSQLite } from '../core/sqlite.mjs';
import { mkdirSync, chmodSync, readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { processIdentity } from '../core/process-identity.mjs';
import { sampleMachine } from './sampling.mjs';
import { assert, digest } from '../core/contracts.mjs';
// Three-valued ownership: permission/I/O errors are uncertain, never proof of death.
export function ownerState(owner) {
  try { if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.bootId) return 'dead'; } catch { return 'uncertain'; }
  if (owner.cgroup !== undefined) {
    if (typeof owner.cgroup !== 'string' || !owner.cgroup.startsWith('/sys/fs/cgroup/') || owner.cgroup.includes('..')) return 'uncertain';
    try {
      let actual;
      try { actual = realpathSync(owner.cgroup); } catch (error) { return error.code === 'ENOENT' ? 'dead' : 'uncertain'; }
      if (!actual.startsWith('/sys/fs/cgroup/')) return 'uncertain';
      const pending = [actual];
      while (pending.length) {
        const path = pending.pop();
        if (readFileSync(path + '/cgroup.procs', 'utf8').trim()) return 'alive';
        for (const name of readdirSync(path)) if (lstatSync(path + '/' + name).isDirectory()) pending.push(path + '/' + name);
      }
      return 'dead';
    } catch { return 'uncertain'; }
  }
  try {
    const current = processIdentity(owner.pid);
    return current.bootId === owner.bootId && current.startTime === owner.startTime ? 'alive' : 'dead';
  } catch (error) {
    try { if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.bootId) return 'dead'; } catch { return 'uncertain'; }
    return ['ENOENT', 'ESRCH'].includes(error.code) ? 'dead' : 'uncertain';
  }
}
export function validateResourceConfig(resources = {}) {
  assert(resources && typeof resources === 'object' && !Array.isArray(resources), 'resource configuration required');
  for (const [resource, pool] of Object.entries(resources.pools ?? {})) {
    assert(/^[a-zA-Z0-9_.-]+$/.test(resource) && pool && typeof pool === 'object', 'invalid resource pool');
    assert(Number.isSafeInteger(pool.capacity) && pool.capacity > 0 && pool.capacity <= 1024, 'invalid resource pool capacity');
    assert(pool.maxLoadAverage === undefined || Number.isFinite(pool.maxLoadAverage) && pool.maxLoadAverage > 0, 'invalid resource load limit');
    assert(pool.minAvailableMemoryBytes === undefined || Number.isSafeInteger(pool.minAvailableMemoryBytes) && pool.minAvailableMemoryBytes >= 0, 'invalid resource memory floor');
  }
  for (const [operation, request] of Object.entries(resources.operations ?? {})) {
    assert(operation && request && resources.pools?.[request.resource], 'operation resource pool missing');
    assert(Number.isSafeInteger(request.weight) && request.weight > 0 && request.weight <= resources.pools[request.resource].capacity, 'invalid resource weight');
  }
  return resources;
}
export function resourceRequest(config, operation) {
  const resources = validateResourceConfig(config.resources ?? {}), request = resources.operations?.[operation];
  if (!request) return {}; // Preserve the original exclusive heavy-work permit.
  return { resource: request.resource, weight: request.weight, ...resources.pools[request.resource] };
}
// The longest a live holder can keep a heavy permit: an effect is capped at one hour, plus
// time for its supervisor to start and settle.
export const LEASE_HOLD_BOUND_MS = 3_600_000 + 300_000;
// Who currently holds a resource, for diagnostics; never used for an authority decision.
export function describeHolders(coordinator, resource = 'heavy-work') {
  const exclusive = coordinator.get(resource), weighted = coordinator.weighted(resource);
  const leases = [...(exclusive && !exclusive.poolFence ? [exclusive] : []), ...weighted];
  return leases.map(lease => `project ${lease.projectId}, flow ${lease.flowId}, attempt ${lease.attemptId} since ${lease.acquiredAt}`).join('; ') || 'no recorded holder (pool limits or machine load)';
}
export class HostResources {
  constructor(path, { inspectOwner = ownerState, sample = sampleMachine } = {}) {
    const absolute = resolve(path); mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.db = openPrivateSQLite(absolute, 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS leases(resource TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS weighted_leases(token TEXT PRIMARY KEY, resource TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resource_pools(resource TEXT PRIMARY KEY, data TEXT NOT NULL);');
    this.inspectOwner = inspectOwner; this.sample = sample;
  }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(resource) { const row = this.db.prepare('SELECT data FROM leases WHERE resource=?').get(resource); return row && JSON.parse(row.data); }
  weighted(resource) { return this.db.prepare('SELECT data FROM weighted_leases WHERE resource=?').all(resource).map(row => JSON.parse(row.data)); }
  status(resource, configured = {}) {
    return this.tx(() => {
      const exclusive = this.get(resource), holders = this.weighted(resource);
      const stored = this.db.prepare('SELECT data FROM resource_pools WHERE resource=?').get(resource);
      const capacity = stored ? JSON.parse(stored.data).capacity : configured.capacity ?? 1;
      assert(Number.isSafeInteger(capacity)&&capacity>0&&capacity<=1024,'invalid observed pool capacity');
      const usedWeight = exclusive && (!exclusive.poolFence || !holders.length) ? capacity : holders.reduce((sum,lease)=>sum+lease.weight,0);
      return { resource, capacity, usedWeight, availableWeight:Math.max(0,capacity-usedWeight), holders:holders.length+(exclusive&&!exclusive.poolFence?1:0), exclusive:Boolean(exclusive&&!exclusive.poolFence), observedAt:new Date().toISOString(), basis:'recorded-leases' };
    });
  }
  acquire({ resource = 'heavy-work', projectId, flowId, attemptId, owner = processIdentity(), weight, capacity, maxLoadAverage, minAvailableMemoryBytes }) {
    assert(projectId && flowId && attemptId && Number.isInteger(owner.pid) && owner.bootId && owner.startTime, 'complete lease identity required');
    const weighted = weight !== undefined || capacity !== undefined;
    if (weighted) validateResourceConfig({ pools: { [resource]: { capacity, maxLoadAverage, minAvailableMemoryBytes } }, operations: { acquire: { resource, weight } } });
    return this.tx(() => {
      const old = this.get(resource), token = digest({ resource, projectId, flowId, attemptId, owner, ...(weighted ? { weight, capacity, maxLoadAverage: maxLoadAverage ?? null, minAvailableMemoryBytes: minAvailableMemoryBytes ?? null } : {}) });
      if (old?.token === token) return old;
      if (old && !old.poolFence) {
        if (this.inspectOwner(old.owner) !== 'dead') return null;
        this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      }
      for (const lease of this.weighted(resource)) if (this.inspectOwner(lease.owner) === 'dead') this.db.prepare('DELETE FROM weighted_leases WHERE token=?').run(lease.token);
      const leases = this.weighted(resource);
      if (old?.poolFence && !leases.length) this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      const existing = leases.find(lease => lease.token === token);
      if (existing) return existing;
      assert(!leases.some(held=>held.projectId===projectId&&held.flowId===flowId&&held.attemptId===attemptId),'live resource request changed; reconcile its original owner first');
      const lease = { resource, projectId, flowId, attemptId, owner, token, acquiredAt: new Date().toISOString() };
      if (!weighted) {
        if (leases.length) return null;
        this.db.prepare('INSERT INTO leases VALUES(?,?)').run(resource, JSON.stringify(lease)); return lease;
      }
      const pool = { capacity, maxLoadAverage: maxLoadAverage ?? null, minAvailableMemoryBytes: minAvailableMemoryBytes ?? null };
      const configured = this.db.prepare('SELECT data FROM resource_pools WHERE resource=?').get(resource);
      assert(!configured || !leases.length || digest(JSON.parse(configured.data)) === digest(pool), 'active resource pool configuration differs; drain all holders before changing shared capacity');
      if (leases.reduce((sum, held) => sum + held.weight, 0) + weight > capacity) return null;
      if (maxLoadAverage !== undefined || minAvailableMemoryBytes !== undefined) {
        let observation; try { observation = this.sample(); } catch { return null; }
        if (!Number.isFinite(Date.parse(observation?.observedAt)) || Math.abs(Date.now() - Date.parse(observation.observedAt)) > 10000) return null;
        if (maxLoadAverage !== undefined && (!Number.isFinite(observation.loadAverage?.[0]) || observation.loadAverage[0] > maxLoadAverage)) return null;
        if (minAvailableMemoryBytes !== undefined && (!Number.isSafeInteger(observation.memoryBytes?.available) || observation.memoryBytes.available < minAvailableMemoryBytes)) return null;
        lease.machineObservation = observation;
      }
      this.db.prepare('INSERT INTO resource_pools VALUES(?,?) ON CONFLICT(resource) DO UPDATE SET data=excluded.data').run(resource, JSON.stringify(pool));
      // Keep a legacy-visible fence while weighted holders exist. Older
      // executors only understand leases(resource); PID 1 keeps their owner
      // check alive until a new executor explicitly drains this pool.
      const fence = { resource, poolFence: true, projectId: 'weighted-pool', flowId: resource, attemptId: 'pool-fence', owner: processIdentity(1), token: digest({ resource, poolFence: true }), acquiredAt: lease.acquiredAt };
      this.db.prepare('INSERT INTO leases VALUES(?,?) ON CONFLICT(resource) DO UPDATE SET data=excluded.data').run(resource, JSON.stringify(fence));
      Object.assign(lease, { weight, pool }); this.db.prepare('INSERT INTO weighted_leases VALUES(?,?,?)').run(token, resource, JSON.stringify(lease)); return lease;
    });
  }
  release(resource, token) {
    return this.tx(() => {
      const old = this.get(resource);
      if (old?.token === token && !old.poolFence) { this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource); return true; }
      const weighted = this.weighted(resource).find(lease => lease.token === token); assert(weighted, 'lease ownership mismatch');
      this.db.prepare('DELETE FROM weighted_leases WHERE token=?').run(token);
      if (!this.weighted(resource).length && this.get(resource)?.poolFence) this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      return true;
    });
  }
  reconcile(resource) {
    return this.tx(() => {
      const old = this.get(resource), leases = [old?.poolFence ? null : old, ...this.weighted(resource)].filter(Boolean); if (!leases.length) return 'absent';
      const states = leases.map(lease => ({ lease, state: this.inspectOwner(lease.owner) }));
      for (const { lease, state } of states) if (state === 'dead') {
        if (lease.weight === undefined) this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
        else this.db.prepare('DELETE FROM weighted_leases WHERE token=?').run(lease.token);
      }
      if (!this.weighted(resource).length && this.get(resource)?.poolFence) this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      return states.some(({ state }) => state === 'uncertain') ? 'uncertain' : states.some(({ state }) => state === 'alive') ? 'alive' : 'dead';
    });
  }
}
