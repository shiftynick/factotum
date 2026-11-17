# Console Stats shows its readiness sections (trial report R4)

**Problem.** In a real browser, the Stats page never showed "Orchestrator session", "Provider limits" or "Accounting coverage". The UI functions were fine, but the data was dropped before it reached the browser:

- the console backend forwards an explicit list of stats fields, and that list lacked `accounting` and `providerLimits`, which the service's `/v1/stats/<window>` returns;
- the Stats page reads `snapshot.orchestratorSession`, but the dashboard snapshot the console polls (`dashboard-v1`) didn't carry it; only the full snapshot did.

The Overview's "Provider limits" link therefore led to a Stats page without that section. Fake-DOM view tests could not see this, because they render from complete data.

**Fix.**

- `console/console.mjs` exports `STATS_FIELDS`, which now includes `accounting` and `providerLimits`.
- `service/dashboard.mjs` adds `orchestratorSession` (the same `orchestratorSessionView` the full snapshot uses) to the dashboard snapshot.

**Tests.** `tests/console-stats-sections.test.mjs` covers three things:

- every top-level key of `projectStats` for each window is in `STATS_FIELDS`, so a future stats field cannot be dropped silently;
- the dashboard snapshot carries the session before and after `orchestrator.session`;
- a stats read through the real console backend keeps `accounting` and `providerLimits` and still drops unlisted fields.

With the source changes stashed the file fails (the console module exports no `STATS_FIELDS`, and the snapshot and forwarding assertions fail). A browser-level check of the section headings is left to the trial's real-browser pass.

**Adopters.** The shared console runs from one pinned copy. Update the copy the console service runs from, as well as each project's service, then restart both.
