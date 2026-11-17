import { stepSpec } from '../../core/step-models.mjs';
import {assert} from '../../core/contracts.mjs';
// Provider turns a model step may take when its route sets no maxTurns (providers.<role>.maxTurns,
// or stepModels.<workflow>.<step>.maxTurns). Claude receives it as --max-turns; Codex has no turn
// cap in this adapter. A build edits and runs checks, so it gets more (dev.84, H9: 16 ended a
// strict build after 17 turns); planners and reviewers keep 16.
export const DEFAULT_MAX_TURNS = Object.freeze({ builder: 60 });
export const FALLBACK_MAX_TURNS = 16;
export const defaultMaxTurns = role => DEFAULT_MAX_TURNS[role] ?? FALLBACK_MAX_TURNS;
// A resumed session belongs to its effective provider and model, including an
// initially selected fallback. Never reinterpret its UUID under another CLI.
export function resolveProviderSpec(config,role,{results={},sessions={},stepModel=null,modelRoute=null}={}){
  const primary=modelRoute??stepSpec(config.providers[role],stepModel);
  if(role!=='builder'||!sessions.builder)return primary;
  const receipt=results.build;
  assert(receipt?.provider&&receipt?.model,'resumed builder needs its effective provider receipt');
  const route=[primary,primary.fallback&&{...primary,...primary.fallback}].filter(Boolean).find(spec=>spec.provider===receipt.provider&&spec.model===receipt.model);
  assert(route,'resumed builder route no longer matches approved configuration');
  const {fallback,allowFallback,...pinned}=route;return {...pinned,allowFallback:false};
}
