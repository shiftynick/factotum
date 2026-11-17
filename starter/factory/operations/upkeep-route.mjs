// Knowledge upkeep: the pinned route of the assessment (operator decision of 2026-11-16 on the
// slice 3 review, Q7; knowledge-upkeep design 6.3 and 9.2).
//
// The assessment's role is providers.upkeep, falling back to the reviewer. Left at that, a change
// to providers.reviewer would change the model the assessment runs on, and the reviewer is not
// upkeep authority: a delegate may change it. So the route is pinned when upkeep is turned on:
//
//   - turning upkeep on (the mode moving up from off) records the route then in force:
//     providers.upkeep if it is set, otherwise the reviewer's route as it is at that moment;
//   - while the pin says "the reviewer's route", the assessment runs on the recorded copy. A later
//     change to providers.reviewer, by anyone, does not reach it;
//   - only the operator changes it: by setting, changing or removing providers.upkeep (each re-pins
//     from the resulting configuration), and, on top of the role, by a step model or models.update;
//   - turning upkeep off clears the pin, so turning it on again pins afresh;
//   - a project that was already observing when it adopted this release has no pin. It is pinned
//     the first time anything could make the difference matter: before any configuration write is
//     applied (from the configuration as it was before the write), and before an upkeep job starts.
//     Either way the route pinned is the one in force when the release was adopted.
//
// One meta row, read only where a model is selected for the upkeep step or a configuration is
// written; an operations tick with no upkeep job to start does not read it.
import { digest, now } from '../core/contracts.mjs';
import { upkeepAuthorityChanges, upkeepOn, usableProviderRoute, withUpkeepRoute } from '../core/upkeep-config.mjs';

export const UPKEEP_ROUTE_META = 'upkeepRoute';
export const pinnedUpkeepRoute = store => store.meta(UPKEEP_ROUTE_META, null) ?? null;
// The configuration a model is selected under for the upkeep step: the stored one, with the
// pinned route standing in for providers.upkeep when the project configures none.
export const upkeepSelectionConfig = (store, config = store.meta('config', {})) => withUpkeepRoute(config, pinnedUpkeepRoute(store));

// The route in force for the assessment's role under a configuration.
function inForce(config) {
  if (usableProviderRoute(config?.providers?.upkeep)) return { source: 'providers.upkeep', route: structuredClone(config.providers.upkeep) };
  if (usableProviderRoute(config?.providers?.reviewer)) return { source: 'providers.reviewer', route: structuredClone(config.providers.reviewer) };
  return null;
}
const record = (config, by, reason, at = now()) => { const found = inForce(config); return found ? { ...found, pinnedAt: at, by, reason } : null; };
function write(store, pin) {
  store.setMeta(UPKEEP_ROUTE_META, pin);
  if (pin) store.event('upkeep.route-pinned', { source: pin.source, provider: pin.route.provider, model: pin.route.model, by: pin.by, reason: pin.reason }); else store.event('upkeep.route-cleared', {});
  return pin;
}
// With upkeep on and no pin yet, pin the route in force under `config`. Call it with the
// configuration as it is before a write, and before an upkeep job selects its model.
export function ensureUpkeepRoutePinnedInTransaction(store, config = store.meta('config', {})) {
  if (!upkeepOn(config)) return null;
  return pinnedUpkeepRoute(store) ?? write(store, record(config, 'factory', 'in-force-at-first-use'));
}
// What the pin is after a configuration write: { pin, changed }. Pure.
export function upkeepRouteAfter(pin, before, after, actor) {
  if (!upkeepOn(after)) return { pin: null, changed: pin !== null };
  const turnedOn = upkeepAuthorityChanges(before, after).turnedUp, roleChanged = digest(before?.providers?.upkeep ?? null) !== digest(after?.providers?.upkeep ?? null);
  if (turnedOn || roleChanged || !pin) return { pin: record(after, actor, turnedOn ? 'turned-on' : roleChanged ? 'providers.upkeep-changed' : 'in-force-at-first-use'), changed: true };
  return { pin, changed: false };
}
export const writeUpkeepRouteInTransaction = (store, { pin, changed }) => changed ? write(store, pin) : pin;
// What Settings shows: where the route comes from and what it is. No private field of the route.
export function upkeepRouteView(store, config = store.meta('config', {})) {
  const pin = pinnedUpkeepRoute(store), route = upkeepOn(config) ? (usableProviderRoute(config?.providers?.upkeep) ? config.providers.upkeep : pin?.source === 'providers.reviewer' ? pin.route : null) : null;
  if (!upkeepOn(config)) return { pinned: false, on: false };
  if (!route) return { pinned: false, on: true };
  return { pinned: true, on: true, source: usableProviderRoute(config?.providers?.upkeep) ? 'providers.upkeep' : 'providers.reviewer', provider: route.provider, model: route.model, effort: route.effort ?? null, pinnedAt: pin?.pinnedAt ?? null, by: pin?.by ?? null };
}
