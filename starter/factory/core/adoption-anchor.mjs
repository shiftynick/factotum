// The project's record of how its adoption lock was authenticated, kept in the project's state
// (outside the checkout, so nothing written to the target can change it).
//
// A root lock written before dev.87 carries no layout evidence and is accepted, unauthenticated,
// during the transition (distribution.mjs). Once a project's lock has been authenticated by its own
// evidence, a later lock in that earlier shape is a downgrade: it would let a managed file be replaced
// together with its hash in the lock with only a warning. From then on such a lock is refused unless a
// verified release directory authenticated it, which upgrade apply records here (`releaseVerified`,
// by the SHA-256 of the exact lock it checked). A project with no record (it never had evidence, or
// its state is new, for example on a fresh machine) keeps the transition behaviour.
import { LOCK } from './install-layout.mjs';

export const ANCHOR = 'adoptionAnchor';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const readAnchor = store => { const value = store.meta(ANCHOR, null); return object(value) ? value : null; };

// After a lock was verified (adoptionStatus): by its own evidence, or, for a lock without evidence,
// against a verified release directory. Returns the record as it now stands.
export function recordAuthentication(store, status, at = new Date().toISOString()) {
  const anchor = readAnchor(store) ?? {};
  if (!status?.authenticated) return anchor;
  const release = { manifestDigest: status.release.manifestDigest, version: status.version };
  let next = anchor;
  if (status.evidence) { if (!anchor.evidence) next = { ...anchor, evidence: { ...release, at } }; }
  else if (status.authenticatedBy === 'release manifest' && anchor.releaseVerified?.lockSha256 !== status.lockSha256) next = { ...anchor, releaseVerified: { ...release, lockSha256: status.lockSha256, at } };
  if (next !== anchor) store.setMeta(ANCHOR, next);
  return next;
}

// Why this lock is refused as a downgrade, or null. `status` is what adoptionStatus computed.
export function downgradeProblem(anchor, status) {
  if (!object(anchor?.evidence) || status.evidence || status.authenticated) return null;
  if (anchor.releaseVerified?.lockSha256 === status.lockSha256) return null;
  return `${LOCK} (release ${status.version}) is a root lock without layout evidence, but this project's lock was authenticated by its evidence before (release ${anchor.evidence.version ?? 'unknown'}, recorded in the project's state${anchor.evidence.at ? ` on ${anchor.evidence.at}` : ''}). From then on a lock in that earlier shape is refused: it cannot show that its managed files are the release's. Prepare the adoption with the release's own CLI (node <release>/starter/factory/cli.mjs upgrade apply …), which writes the evidence, or apply it with --release <the release directory with its digest> (upgrade apply --merge, or --activate), which checks its files against the verified manifest and records that here`;
}
