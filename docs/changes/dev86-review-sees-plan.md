# The reviewer sees the reviewed plan when judging scope

**Report (adopter, dev.85).** The reviewer is told to treat a change outside the task's declared `paths` as a finding "unless the reviewed plan justifies it", but its prompt (`workflows/dispatch.mjs`, `provider.review`) never contained the plan. A flow whose reviewed plan legitimately named files outside the brief's narrower declared paths (new modules, a migration, tests) was blocked by review on every round, and the builder could not fix that from inside the flow.

**Fix.** `workflows/task-scope.mjs`:

- `reviewedPlanScope(results)` returns the plan that passed plan review (`results['plan-review'].route === 'pass'`): its summary (at most 4,000 characters) and the files it named (at most 100 entries of 300 characters, with the count of the rest). It returns null when the flow has no plan that passed review.
- `scopeReviewGuidance(paths, outside, plan)` now splits the out-of-scope changed files into those the reviewed plan names (justified; a finding only where the change goes beyond what the plan describes for that file) and those it does not (a blocking finding unless the plan's summary clearly covers it). It always includes the reviewed plan as model-written data, or says that no reviewed plan applies.
- `namedInPlan` matches a changed file only as a whole path inside a plan entry (plan entries are free text such as `src/a.mjs: add the parser`), so a longer path or a prefix is not a mention.

Declared paths stay admission evidence; nothing about admission or path overlap changes. The reference graphs are unchanged.

**Tests.** `tests/review-reviewed-plan.test.mjs` (3 tests; the file fails on the base because `reviewedPlanScope` does not exist). One assertion in `tests/trial-code-items.test.mjs` (F36) follows the new wording.

## Review fixes (root)

Independent review (GPT-6.1 Sol) of `2969465`: approve with fixes. It confirmed the plan-review pass condition (strict plans, `proceed`, replans and conflict repair all reach a fresh plan review before building; unplanned and adopted flows get no plan), the bounding and data labelling of the plan text, the regex's safety, and that delta, final and satisfied reviews share the prompt.

- **A mention became an authorization (blocking).** A plan entry "Do not touch src/x" matched `src/x`, and the prompt called it "justified by the plan"; "src/report final.mjs: add report" also matched the different file `src/report`. Files the plan mentions are now "mentioned in the reviewed plan": the reviewer must read what the plan says, treat a planned change as in scope only up to what the plan describes, and treat a restriction, a mere reference or an ambiguous mention as out of scope. A change outside the declared paths that the plan does not positively justify stays a blocking finding. Regression: "a restricting or ambiguous mention is not presented as a justification".
- **No integration test (non-blocking).** The F36 test in `tests/trial-code-items.test.mjs` now runs `provider.review` through `runAction` with a plan that passed review and asserts the plan and its mention reach the reviewer's prompt.

With the source change removed, 3 of the tests fail (the regression, the renamed assertions and the integration case); with it, all pass.
