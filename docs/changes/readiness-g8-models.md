# Readiness G8: product model defaults, per-task model choice, same-family review

Implementation against dev.80 on branch `t3/task-model-defaults-review`; not a release and not a live qualification. It carries out three operator decisions of 2026-11-14.

## 1. Same-family review is allowed

The family-independence rule is retracted. A reviewer may come from the same model family as the builder (for example Claude builds and Claude reviews). Every place that enforced it is removed:

- **Configuration:** `validateConfig` no longer refuses a builder and reviewer on the same provider. `policy.allowSameFamilyReview` is now an obsolete setting: validation drops it so older configurations still commission, and `config update` reports it in `ignoredSettings` with the reason "same-family review is always allowed". `OBSOLETE_SETTING_REASONS` gives each obsolete setting its own reason.
- **Model selection:** `selectFlowModels` (saved defaults, run overrides, Settings → Models) no longer refuses a same-provider builder and reviewer.
- **Provider adapter:** `checkSpec` no longer raises `INDEPENDENCE_REQUIRED`. The `independenceFamily` and `allowSameFamilyReview` spec fields are ignored if an integration still passes them. As a result a configured fallback is no longer used to switch a same-family reviewer to the other family before launch: the reviewer runs its own primary. Fallback still applies only to positively unstarted failures and never to a resumed builder.
- **Delivery review:** `dispatch.mjs` no longer binds the reviewer to the builder's family or asserts after the review.
- **Console and settings views:** the "Same-family review" policy row and its pinned default are gone.
- **Docs and starter:** `docs/integrations/providers.md`, `docs/project-workflows.md`, `docs/adoption.md`, `docs/design.md`, `docs/review.md`, `docs/implementation-plan.md`, `docs/project-workflows-design.md`, the starter README, SETUP_CHECKLIST and factotum-workflows skill no longer claim that review is cross-family. "Independent review" in the docs now means a separate, fresh reviewer session, which is still enforced.

**The pairing stays visible.** A code review's result keeps `independence`, now `same-family` or `different-family` (previously `different-family` or `explicit-exception`), or `external-author-unknown-manual-decision-required` for an adopted pull request. It also records `pairing: {builder: {provider, model, family}, reviewer: {provider, model, family}}`. The strict-review requirement still carries the reviewer's provider, model, family and independence into the operator's acknowledgement digest. No new refusal was added.

**Nothing else depended on cross-family review.** Checked: strict review rules (`core/risk.mjs`, `core/delivery-review.mjs`) read only the review verdict, findings, scope and strict attestations; the merge path's manual mode for adopted pull requests depends on `candidate`, not on family; commissioning preflights roles and step routes without a family check. The only family-switching behaviour was the adapter fallback described above.

## 2. Product defaults

`starter/project/factotum.template.json` now ships:

| Role | Provider | Model | `allowedModels` |
| --- | --- | --- | --- |
| planner | `claude` | `claude-opus-5-5` | `claude-opus-5-5`, `claude-fable-5-2` |
| builder | `claude` | `claude-opus-5-5` | `claude-opus-5-5`, `claude-fable-5-2` |
| reviewer | `codex` | `gpt-6.1-sol` | `gpt-6.1-sol` |

Claude Fable 5.2 is listed for the most important or complex planning, building or review, chosen per task (below). The identifiers are the ones passed to each CLI's `--model`: full Claude identifiers rather than Claude Code's short aliases, which resolve to whatever version the CLI picks, and `gpt-6.1-sol` as already used by the template and the recorded qualification. `policy.allowSameFamilyReview` was removed from the template, and the reviewer's Claude-only `maxTurns` went with the switch to Codex. The template validates (tested). Existing project configurations are not changed.

## 3. Per-task model choice

`task.models {taskId, models, note?}`, where `models` maps `planner`, `builder` and `reviewer` to `{model, provider?, effort?}`, or `null` to clear. `task.put` accepts the same `models` field.

- **Scope.** A role choice applies to every model step of that role in the task's workflow, so `reviewer` covers the plan review and every code review. Precedence is now: run `modelOverrides` (per step) → task choice (per role) → saved default → project `stepModels` → provider role. A step's selection source is `task` when the task choice applied.
- **Not part of the approved brief.** It is stored on the task beside `labels` and `notBefore`, outside `BRIEF_FIELDS`, so it does not change the revision, keeps approval, and survives brief edits. Reason: the brief is what gets built and how it is accepted. The model choice only selects among routes the project already allows, it is pinned with the flow at admission and recorded in that flow's evidence, so the operator can always see which model did the work. Putting it in the brief would make every model change a re-approval (and, on migrated projects, a new grant for the orchestrator), which is the opposite of the "easy" choice the operator asked for.
- **Authority.** The operator or the orchestrator, with no instruction or grant: the same authority as `flow.start`'s existing `modelOverrides`, which already let either actor choose models for a run. It is therefore not added to `policy.delegatedOperations`.
- **Boundary.** A choice must use a provider already configured for a role and stay within that provider's `allowedModels` (the existing run-override rules in `applySelection`). Anything else is refused with "… A model outside the project's configured providers and allowedModels is a project setting change (config update), not a task choice". The choice is checked when saved, against the task's commissioned workflow when there is one, and again at admission. A choice made invalid by a later configuration change refuses admission with that reason rather than running another model.
- **Every admission path.** The choice is read in `admitFlow`, so Start now, `flow.start`, the queue, automatic queueing and `task.restart` all pin it. Maintenance flows are unaffected.
- **Sessions.** Admission pins the complete routes as before. Changing the task choice never touches a running flow: retries, replans and resumed builder sessions keep the pinned route, and `resolveProviderSpec` still refuses to resume a session under a different provider or model. To use a new choice, restart the task.
- **Shown in.** Task detail: "Models for the next flow" (task choice marked "Chosen for this task", otherwise the project default from Settings) and a "Choose models for this task" form with "Use project defaults". Flow detail → Models pinned for this flow: source "task choice". Settings → Models: source label and updated precedence text. Stats → Models: each model row counts invocations "chosen per task or run". `flow.modelSelection.taskModels` records the choice that applied; events record `task.models` with the actor.

## Compatibility

- Tasks without `models` and flows admitted from them are unchanged: no `taskModels` key and the same selection sources (tested). The route digest covers routes only, so it is unchanged when the routes are.
- Configurations that set `policy.allowSameFamilyReview` keep working; the key has no effect, and `config update` reports it as ignored. A stored configuration is not rewritten until the operator next runs `config update`.
- Review results from earlier flows keep their recorded `independence` values (`explicit-exception` may still appear in history).
- Integrations that still pass `independenceFamily`/`allowSameFamilyReview` to the provider adapter are not refused; the fields are ignored.
- No migration and no change to existing project configuration.

## Verification

Run on 2026-11-14 in this worktree:

- Focused: `node --test tests/task-models.test.mjs tests/model-settings.test.mjs tests/providers.test.mjs tests/stats-view.test.mjs`: 49 tests, 49 passed, 0 failed.
- Full suite, `npm test`: 730 tests, 730 passed, 0 failed, 0 cancelled, 0 skipped. No reruns were needed.
- `npm run eval`: exit 0; both fictional projects completed and the shared console check passed.
- `git diff --check`: clean.

New tests (`tests/task-models.test.mjs`, plus one in `tests/stats-view.test.mjs`): a same-family configuration is accepted and the legacy flag is reported as ignored; a same-family review through the real dispatcher passes and records `independence: same-family` and the pairing, with no family binding sent to the provider; a task choice applies to the right roles and steps, under a run override, keeps approval and survives a brief edit; choices outside the configured providers or allowlists, unknown roles, unsupported effort and extra fields are refused, including at admission after a narrowing configuration change; the orchestrator can choose, a running flow keeps its routes, a resumed builder keeps its session provider, and a restart picks up the new choice; tasks without a choice are unchanged; the starter template validates and allows Fable per task; the console task row and Stats count show the choice. Changed tests: two provider tests and two model-settings assertions that expected the family refusal now expect acceptance.

Not verified: that the installed Claude Code and Codex CLIs accept `claude-opus-5-5`, `claude-fable-5-2` and `gpt-6.1-sol` under subscription authentication (no live provider smoke was run), and the console changes in a real browser.

## Independent review fixes (root)

Review of `0c66c06` (GPT-6.1 Sol): approve with fixes; the three root answers (planner default, orchestrator authority, no doctor preflight of every allowed model) were judged not defects. One blocking finding fixed: a provider role without `allowedModels` treated a task choice as unrestricted, so `task.models` could name any model and `flow.start` pinned it. A task choice must now name a model already configured for its provider — listed in a role's `allowedModels` or used by a provider role or step route — checked after the existing provider check, at save and again at admission. A provider without an allowlist therefore allows only the models already configured for it. Regression (legacy config without a builder allowlist: an unknown model and an unknown cross-provider model refused; the builder's and planner's configured models allowed; a stale saved choice refused at admission) fails on `0c66c06`.

Re-check of `9cb260a`: the unknown-model case was confirmed fixed; one further blocking gap, fixed by root. A `stepModels` entry without its own provider was credited to the choosing role's provider instead of its step's. A Codex planner step's model could therefore be saved as a Claude builder choice, and the correct Codex choice was refused. Such an entry is now attributed to its step's role provider through the workflow graph. When that graph is not at hand, at admission for another workflow, the entry is not counted, so the check fails closed. Regression in both directions fails on `9cb260a`.

Noted, unchanged: saved defaults (operator or recorded delegation) and per-run overrides (`flow.start` `modelOverrides`, which the orchestrator can set directly) keep their earlier rule. With no allowlist they can name any model. This predates G8. Whether to restrict orchestrator run overrides the same way is a separate decision.

Second re-check of `330c1d9`: attribution confirmed fixed in both directions; one further, pre-existing gap fixed by root. A task choice was checked against the choosing role's provider rather than the provider its step actually runs. With a Claude builder and an explicit Codex build-step route, a Claude-only model could run as Codex. The check now validates the effective provider and model after selection. The save-time helper without a workflow can still accept a model found only in another workflow's providerless step that admission would refuse. Command callers pass the selected workflow, so no command-level mismatch was reproduced; admission always fails closed.

**Per-run overrides (operator decision 2026-11-14).** `flow.start` `modelOverrides` now follow the same rule as task choices: only models configured for the effective provider. This is an adopter-facing change. An orchestrator that overrides runs with a model missing from `allowedModels` and from the configured routes will be refused, so list such models in `allowedModels`. Saved defaults (operator or recorded delegation) keep their earlier rule. The existing pinned-overrides test now lists its run model in the planner's allowlist. Regression for both rules fails on `330c1d9`.
