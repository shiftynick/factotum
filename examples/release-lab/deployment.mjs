import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, atomicJSON, digest } from '../../starter/factory/core/contracts.mjs';
export function createLocalDeployment(root) {
  mkdirSync(join(root, 'versions'), { recursive: true }); mkdirSync(join(root, 'receipts'), { recursive: true });
  const saved = join(root, 'saved.json'), pointer = join(root, 'current.json');
  if (!existsSync(saved)) atomicJSON(saved, { items: [{ id: 'fixture-1', title: 'Fictional saved item', completed: false }] });
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const receiptPath = operationId => join(root, 'receipts', digest(operationId) + '.json');
  return {
    probe: async () => ({ savedItems: read(saved).items, current: existsSync(pointer) ? read(pointer).version : null }),
    deploy: async ({ operationId, candidate }) => {
      assert(/^[a-zA-Z0-9._-]+$/.test(candidate.version), 'invalid local version');
      if (existsSync(receiptPath(operationId))) { const existing = read(receiptPath(operationId)); assert(existing.candidateDigest === digest(candidate), 'operation identity reused'); return existing; }
      const artifact = { version: candidate.version, behavior: candidate.behavior ?? 'healthy' };
      assert(!candidate.artifactDigest || candidate.artifactDigest === digest(artifact), 'candidate artifact mismatch');
      const previous = existsSync(pointer) ? read(pointer) : null;
      const artifactPath = join(root, 'versions', candidate.version + '.json');
      if (existsSync(artifactPath)) assert(digest(read(artifactPath)) === digest(artifact), 'version artifact is immutable');
      else atomicJSON(artifactPath, artifact);
      // Saved-data mutation is deliberately a test failure in the fictional candidate.
      if (candidate.behavior === 'broken-migration') atomicJSON(saved, { items: [] });
      // Receipt intent precedes pointer mutation; lookup checks the actual pointer after a crash.
      atomicJSON(receiptPath(operationId), { status: 'prepared', operationId, candidateDigest: digest(candidate), previous });
      atomicJSON(pointer, { version: candidate.version, operationId, candidateDigest: digest(candidate) });
      const result = { status: 'applied', operationId, version: candidate.version, candidateDigest: digest(candidate), previous }; atomicJSON(receiptPath(operationId), result); return result;
    },
    lookup: async ({ operationId, candidate }) => {
      if (!existsSync(pointer)) return { status: 'not-applied' };
      const current = read(pointer);
      if (current.operationId !== operationId || current.candidateDigest !== digest(candidate)) return { status: 'unknown' };
      const receipt = existsSync(receiptPath(operationId)) ? read(receiptPath(operationId)) : {};
      return { ...receipt, status: 'applied', operationId, version: current.version, candidateDigest: current.candidateDigest };
    },
    smoke: async () => {
      if (!existsSync(pointer)) return { passed: false, evidence: 'no current version' };
      const current = read(pointer), artifact = read(join(root, 'versions', current.version + '.json'));
      return { passed: artifact.behavior === 'healthy', evidence: { current, savedCount: read(saved).items.length, artifactDigest: digest(artifact) } };
    },
    rollback: async ({ operationId, deployment }) => {
      assert(deployment.previous, 'no previous deployment to restore'); atomicJSON(pointer, deployment.previous); const receipt = { status: 'applied', operationId, restored: deployment.previous }; atomicJSON(receiptPath(operationId), receipt); return receipt;
    },
  };
}
