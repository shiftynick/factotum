# Knowledge upkeep, slice 3: the model assessment, the validator and bounded telemetry

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 3. Base: `main` at `9c4fe70` (slices 1 and 2). Built in `59c43d3`; `main` at `45911d9` merged in `153e65e`. Review fixes in `800d1d5`, see [Review of `bbfe0aa`](#review-of-bbfe0aa); the re-check's in the commit that carries this revision of the record, see [Re-check of `800d1d5`](#re-check-of-800d1d5).

With `upkeep.mode: "observe"`, a run whose pre-filter finds something to assess now asks a model once and puts the answer through a deterministic validator. **It still writes no candidate row and creates no task**: it counts what the validator kept and dropped. Upkeep stays off unless the operator turns it on.

**Three existing behaviours change.**

- **A project that already observes starts making model calls**, at most 30 a day. See [adopter notes](#compatibility-and-adopter-notes) for how to keep it to the deterministic part.
- **Stats counts a `not-dispatched` model attempt with no recorded invocation as none**, where it counted one. This is the change the design announces in 4.5 and 16.
- **`providers.upkeep` is validated.** The release before tolerated any value there.

The notes an adopter needs are in [For the release notes](#for-the-release-notes).

## What was built

| Piece | Where |
| --- | --- |
| Evidence blocks: items, provenance, cleaning, serialising and parsing | `operations/upkeep-evidence.mjs` (pure) |
| The fixed instruction text, the result schema, the bounded evidence, the text rules, the validator | `operations/upkeep-assessment.mjs` (pure) |
| A line comparison of two texts | `core/line-diff.mjs` (pure) |
| The daily reservation and the maintained invocation totals | `operations/upkeep-budget.mjs` |
| The model stage of a run: route, evidence, checkout, reservation, the one invocation, validation | `workflows/upkeep-assess.mjs` |
| The one counting function, used by the projection and by both hooks | `operations/usage-accounting.mjs` (`attemptInvocations`, `isModelOperation`) |
| The hooks: the engine's settlement, `attempt.resolve`, `task.restart` | `core/engine.mjs`, `core/project.mjs` |
| The pinned route of the assessment | `operations/upkeep-route.mjs`, `core/upkeep-config.mjs` (`withUpkeepRoute`), `operations/model-settings.mjs`, `core/project.mjs` |
| The model graph `maintenance/knowledge.upkeep` and its role rule | `core/step-models.mjs`, `adapters/providers/index.mjs` (the role), `workflows/commission.mjs` (the probe), `core/configuration.mjs` (`providers.upkeep`) |
| `models.update` and a delegated `replaceLive` for the upkeep step | `core/project.mjs` |
| The run record: outcomes, stages, reasons, drop counts, the window's two flags | `operations/upkeep-runs.mjs` |
| The step's time, and a provider hold at job start | `operations/effect-timeouts.mjs`, `workflows/maintenance.mjs` |
| Stats: upkeep's day totals and runs by outcome | `operations/stats-view.mjs`, `console/console.mjs`, `console/ui/stats.mjs` |

### The invocation (6.3)

- **When.** Only when the pre-filter returns something to assess: a declared doc or a governing file refers to what the merge touched, or the flow recorded a verified correction. Every other run ends as it did in slice 2, with no model call.
- **How.** One read-only provider invocation in a throwaway detached checkout of the merge commit (`git worktree add --detach`, no `workspace.setup`), removed afterwards. Never repeated: an empty answer is valid, and nothing is repaired by a second call.
- **Bounds.** `upkeep.budget.maxTurns` provider turns (a route's own smaller limit applies), `upkeep.budget.timeoutMs`, cut short to the step's time left, and `upkeep.budget.maxInputChars` for the evidence block.
- **The step's time.** Its Git calls, the model call and a 90-second reserve: 18.5 minutes with the defaults. `timeouts["knowledge.upkeep"]` still sets the whole step's limit.
- **Kept with the attempt.** `provider/prompt.txt` (secrets redacted, as for any model step) and `upkeep-assessment.json`: what the validator kept and dropped.

### Model selection (6.3, 12)

- The workflow key is `maintenance/knowledge.upkeep`, step `run`. The graph is a built-in model graph of every delivery project, whatever the mode, so a stored step model stays valid when the mode is turned down.
- The role is `providers.upkeep` when it is a usable route, otherwise the reviewer (Q5). `stepModels["maintenance/knowledge.upkeep"].run` and a live default (`models.update`) apply as for any model step. Settings → Models shows the step.
- **The route is pinned when upkeep is turned on** (operator decision on Q7, see the [review](#review-of-bbfe0aa)). One meta row, `upkeepRoute`, records the route then in force: `providers.upkeep` if set, otherwise a copy of the reviewer's route. While the record is a copy of the reviewer's route, the assessment runs on the copy, so a later change to `providers.reviewer` does not reach it. Where a model is selected for the step, the configuration carries the copy as `providers.upkeep`, so the step's role reads `upkeep` in Settings → Models and on the flow.
- Doctor preflights `providers.upkeep` when it is configured.

### Evidence blocks (6.5)

- **The block.** An opening marker line, one JSON object per item on its own line, a closing marker line. JSON escapes every line break, and `<` and `>` are escaped too, so text inside an item cannot start a line, close the block, begin a heading or repeat a marker.
- **Each item** has a short id (`S1`, `X3`), a kind, a provenance (who produced it, the source flow, and for repository text the file, line and Git blob id), a trust label (`untrusted-evidence`, or `advisory-learning`) and its text, bounded, with control characters, terminal escape sequences and bidirectional overrides removed.
- **The instruction text is one constant.** It never contains evidence. What was cut is said in the block, as `truncation` items.
- **Delivery point in this slice:** the assessment prompt. The others in the design's table arrive with the slices that deliver them.

What the block holds: the task's title and acceptance criteria; the merged diff (computed by the factory from verified blobs); for each candidate file, the lines that refer to a touched path with three lines either side; the lesson signals; the rules fast checks own; the titles of open candidates; the anchors a capture candidate may name.

### The validator (6.4)

Deterministic, after the model and before anything is recorded. A candidate is dropped at the first rule it fails and counted under that rule:

| Rule | Drops |
| --- | --- |
| `malformed` | A result or candidate of the wrong shape |
| `over-count` | More than `maxFiles` docs edits, three context proposals or one capture candidate |
| `over-length` | A quote, replacement, reason, title or text over its bound |
| `part-not-assessed` | A candidate for a part this run does not assess (suspended, or a full backlog) |
| `file-not-allowed` | A file outside the docs set (for a docs edit) or the project-owned governing files (for a proposal) |
| `input-truncated` | A file whose excerpts were cut |
| `quote-not-found` | A quote that is not, after whitespace collapsing, in the excerpts the model was shown |
| `topic-not-offered`, `anchor-not-offered` | A topic outside the fixed list, an anchor outside the offered list |
| `unknown-signal`, `no-verified-correction` | A cited signal that does not exist; a capture candidate with no verified correction |
| `text-rule` | Model-written text that fails a mechanical text rule of 6.5, or holds a character nobody sees (also in a reason), or a word that mixes scripts (also in a reason and a quote) |
| `duplicate` | The same class key twice in one result |

A run where everything was dropped ends `invalid`.

### The daily reservation (6.6)

- One transaction reads the clock and the day's `upkeepDay` row, refuses when reserved plus settled has reached `maxModelRunsPerDay`, and records the reservation under the attempt's id. The function refuses to run outside a transaction, and takes a clock, not a time: the day is the one it is when the reservation is made.
- The same attempt id never reserves twice: the day row names it, and so does the run.
- At the limit the run ends `abstained:budget`. It is closed, not queued for the next day.
- Settlement moves the reservation to settled, with the observed usage. A failed, stopped or aborted attempt stays counted. A reservation is given back only when its attempt is settled as not dispatched and its receipt names no invocation.
- An uncertain attempt keeps its reservation. `attempt.resolve` settles it or gives it back in its own transaction.

### The maintained invocation totals (4.5)

- **One counting function** (`attemptInvocations`), with the four rules of 4.5. `knowledge.upkeep` is a model operation. An upkeep result always carries the list, on a failure too, and an empty list means none.
- **Two hooks**, each in the transaction that settles the attempt, each only while upkeep is not off: the engine's settlement, and `attempt.resolve` (`task.restart`, which settles an uncertain attempt the same way, is hooked too). The attempt records `invocationsCounted: {day, count, upkeep}` and is never counted twice.
- **Attribution.** An invocation is upkeep-attributed when its attempt belongs to the upkeep job's own flow or to a flow whose task snapshot carries the marker.
- **Reads.** The hook reads and writes one `upkeepDay` row by key, and only when the count is not zero. With upkeep off it reads nothing.

### The run telemetry (8.5)

`upkeepRun` gains: the outcomes `invalid` and `candidates`; the stages `reservation`, `model` and `validator`; the reasons below; `dropped` (counts by rule); `modelRun` (the reservation); `usage` (`{invocations, tokens}`); the flags `input-truncated`, `diff-truncated`, `signals-truncated`, `lists-truncated`; counters for the evidence size and for what was kept. Enums and counters only.

| Outcome | Reason | Stage |
| --- | --- | --- |
| `nothing` | `no-candidate` | `model` |
| `abstained` | `insufficient-evidence`, `not-repeatable`, `already-covered` | `model` |
| `candidates` | `observed` | `validator` |
| `invalid` | `all-dropped` | `validator` |
| `abstained` | `budget`, `assessment-unavailable` | `reservation` |
| `abstained` | `model-failed`, `turn-limit` | `model` |

Each window entry now says whether the run reached a model (`model`) and whether it produced a candidate (`candidates`): the two rates of 8.3 that slice 4 evaluates.

## Carry-overs from the slice 2 review

| Carry-over | What this slice does |
| --- | --- |
| Protect `models.update` for the upkeep step | A `models.update` that names `maintenance/knowledge.upkeep` is refused to anyone but the operator, on schema 1 and schema 2, whatever it would set and whatever the mode. A delegated `config update --replace-live` cannot discard the operator's live default for it. Other workflows stay as delegable as they were. Tests: `tests/upkeep-model.test.mjs`, "schema 1: …" and "schema 2: …" |
| `assessment-unavailable` does not count as reaching a model | Kept. The reason now means: something was to be assessed and every provider the step could start was held when it ran. No model run is reserved and no invocation is counted. `upkeepRunReachedModel` is the one definition, and the window entry carries it. Test: "a provider usage hold: …" |
| Settle the provisional limits | **Settled as ceilings.** `budget.maxInputChars` 40,000, `maxTurns` 6, `timeoutMs` 5 minutes and `maxModelRunsPerDay` 30 may be lowered and not raised, like the other limits. The design does not say otherwise; they bound what one assessment reads and costs and how many run. `learnings.maxSelected` and `maxChars` stay provisional for slice 8. Test: "the model budget limits are ceilings: …" |
| Console Stats and accounting count upkeep invocations by the 4.5 definition | Stats uses the same `attemptInvocations` and `isModelOperation` as the totals. Stats also shows upkeep's day totals and runs by outcome. Test: "the maintained totals: …" compares the day's total, the projection and Stats |

## Decisions taken where the design was silent or ambiguous

Each is the conservative reading. The eight that were open questions are settled; see [Settled after review](#settled-after-review).

| # | Point | What this slice does |
| --- | --- | --- |
| 1 | What `maxInputChars` bounds. | The evidence block. The instruction text is fixed, 3,822 characters, and is not counted. |
| 2 | The fields of a candidate. | A docs edit is `{file, quote, reason}`: its follow-up task's builder writes the correction (7.2). A context proposal adds a replacement of at most 600 characters. A capture candidate is `{form, anchor, topic, title, text, reason, signals}`. Settled as built (Q1). |
| 3 | A file that is a candidate only by a mapping has no matching line. | It is shown from its first line. If that does not fit, its excerpts are cut and nothing is accepted for it. Settled as built (Q2). |
| 4 | Which text rules are mechanical. | Refused: text addressed to a model, agent or assistant by name; a claim of authority or permission; an instruction to ignore or override other rules; a credential; control characters; any character nobody sees. Flagged and kept: a link, a command, a mention of agents. Settled as built (Q3); the rules are matched on text with compatibility forms folded (review P2-3). |
| 5 | The quote must be "in the excerpts the model was actually shown". | It must be in a shown excerpt both as shown (cleaned) and as it stands in the file. |
| 6 | A provider hold and a configured fallback. | The job waits while every provider the step could start is held. A fallback the project configured is "asked": the adapter uses it only when the first provider did not start, so one run still starts one model. Settled as built (Q4). |
| 7 | A run a drain stopped during its model call. | Its model run stays counted, and the run is closed (`abstained:stopped`, stage `model`). It is not queued again. A run a drain stopped before it reserved a model run returns to pending, as in slice 2. Changed in the review (Q5). |
| 8 | A provider that did not start (a failed preflight). | The reservation stays counted and one invocation is named, as the audit does. |
| 9 | A model result the provider adapter cannot validate. | The provider process ended, so the end is known: the attempt fails and the run closes `model-failed`. A turn limit is a known end too (`turn-limit`). An end that is not known (a timeout, a cancellation, a transport failure, a usage limit) leaves the attempt uncertain. Changed in the review (Q6). |
| 10 | The reviewer fallback and authority. | The route is pinned when upkeep is turned on; `providers.reviewer` stays delegable and no longer reaches the assessment. Operator decision in the review (Q7). |
| 11 | Which day a count belongs to. | The totals: the UTC day of settlement. A reservation: the day it was made, also when it settles later. |
| 12 | Marking attempts. | Every attempt settled while upkeep is on gets `invocationsCounted`, a count of zero included. |
| 13 | Anchors. | Typed values: `check:<id>`, `context:<id>`, `dir:<path>`. A review-correction signal now carries the finding's `file`, from which the directories are taken. |
| 14 | Titles of learnings (6.3). | Not delivered yet: reading a learning's frontmatter is slice 8. The block and the injection fixture cover a learning item. |
| 15 | Provenance of what the factory computes. | A sixth value, `factory`, for truncation notes and for signals the factory itself recorded (check corrections). |
| 16 | The turn limit on Codex. | The adapter passes no turn cap to Codex. `maxTurns` bounds a Claude call; `timeoutMs` bounds both. |
| 17 | A third settlement point. | `task.restart` settles an uncertain attempt as failed; it counts and settles the reservation like `attempt.resolve`. |
| 18 | The stage of `budget`. | `reservation`. 6.2 lists the reason with the pre-filter's; it is decided after the pre-filter, when the reservation is refused. |
| 19 | A stored `providers.upkeep` that is not a route. | Not used: the reviewer runs the assessment, and `config update` refuses the value. |
| 20 | A checkout left by a killed step. | It stays registered in the project repository, as a killed `target.sync` leaves its own. |
| 21 | What "a character nobody sees" covers (review P2-3). | Unicode category Cf, every default-ignorable code point, every variation selector and the Braille blank. Model-written text that holds one is refused, an emoji with a variation selector or a joiner included. A quote is the repository's own text and is taken verbatim, invisible characters included; a quote with a word that mixes scripts is refused (25). |
| 22 | A reason and the text rules (review P2-3). | A reason is not judged for what it says (it is not a text later agents act on), but it may hold no control or invisible character. |
| 23 | When a project that already observes is pinned (Q7). | At whichever comes first: any `config update` or `settings update` (from the configuration as it was before the write), or the start of an upkeep job. So the route pinned is the one in force when the release was adopted. |
| 24 | What re-pins (Q7). | Turning upkeep on, and a change of `providers.upkeep`; both are the operator's alone. A change to `providers.reviewer` never does, whoever makes it. Turning upkeep off clears the pin. |
| 25 | What a word is, and what one script is (re-check P2). | A word is a run of letters, marks, digits and underscores, taken after NFKC folding. Common and Inherited characters are neutral. Han counts with the scripts it is written with, as in UTS #39, so a Japanese or Korean word is one script. Latin joined to another script in one word is refused, also Latin written against kana with no space, and a unit such as `k` with a Greek omega. |

## Not in this slice

- Candidate rows, observed classes, the evaluation of the windows, suspension by ceiling, Health (slice 4). The validator's kept candidates are counted, never written.
- Task creation and enforcement on the candidate (slice 5).
- Capture creation (slice 7). The validator already applies every capture rule of 6.4, so a scripted capture candidate is counted or dropped.
- Learning selection and delivery (slice 8).
- Release notes. The adopter notes below are written for the release step to carry over.

## Compatibility and adopter notes

### For the release notes

Written to be carried into the release notes as they stand. dev.87 shipped slice 2, so a project may already have `upkeep.mode: "observe"`, and there it made no model calls: the first note is for such a project.

**Knowledge upkeep now asks a model (observe mode).** Upkeep is off unless you turned it on. If your project has `upkeep.mode: "observe"`, this release changes what it does:

- **It starts making model calls.** After a merged change, when a declared doc or a governing file refers to what the merge touched, or the flow recorded a verified correction, the factory asks a model once what it would change, and counts the answer. It still writes no candidate and creates no task. Most merges need no call.
- **How many.** At most one call per merged flow and at most 30 a day (`upkeep.budget.maxModelRunsPerDay`). Each call is bounded to 6 provider turns, 5 minutes and 40,000 characters of evidence. Nothing is retried.
- **To make no model calls at all**, set `upkeep.budget.maxModelRunsPerDay` to `0` with `config update` (the operator only). Runs that would have asked a model then end `abstained:budget`, and everything else is recorded as before. Or turn `upkeep.mode` off.
- **Which model.** `providers.upkeep` if you configure it; otherwise the reviewer's route. To use a smaller model, add `providers.upkeep`, for example `{"provider": "claude", "model": "<a small model>"}`, or a step model `stepModels["maintenance/knowledge.upkeep"].run`. Only the operator can.
- **The model is pinned.** The route is recorded when upkeep is turned on, and for a project that already observes, at the first configuration write or upkeep run after adopting this release. Changing `providers.reviewer` afterwards does not change the model upkeep uses. To change it, set `providers.upkeep`, or turn upkeep off and on again. Settings → Policy → Knowledge upkeep shows the pinned route.
- **Limits are ceilings.** `upkeep.budget.maxInputChars` (40,000), `maxTurns` (6), `timeoutMs` (5 minutes) and `maxModelRunsPerDay` (30) may be lowered and not raised.

**`providers.upkeep` is validated.** It must be `{provider: "codex" | "claude", model}`, subscription-backed. Earlier releases ignored the key. A stored value that is not such a route is not used (the reviewer's route runs the assessment) and is refused by `config update`, `settings update`, doctor and the `upgrade apply` check, which names it. Remove or correct it, as the operator, with the release you run now.

**Stats.** A model step that was never dispatched and recorded no invocation now counts as no invocation, where it counted as one. Upkeep assessments are counted as model steps. A Knowledge upkeep section appears once upkeep has recorded a run.

**Settings → Models** shows one more step for every delivery project: `maintenance/knowledge.upkeep`, `run`. Only the operator can change it; a delegated `models.update` for it is refused.

**Going back to an earlier release.** Turn `upkeep.mode` off and let one tick pass. Reset a saved model default for `maintenance/knowledge.upkeep` (Settings → Models, or `models.update` with `null`) and remove a `stepModels` entry for it: an earlier release refuses both as an unknown workflow.

### A project that already observes: when its route is pinned

Such a project has no pin when it adopts this release. It is pinned by the factory at whichever of these comes first, so the route recorded is the one in force when the release was adopted:

- any `config update` or `settings update`, before the change is applied and from the configuration as it was. This includes the `config update --current` that `upgrade apply` runs at activation, and it includes a delegate's change of the reviewer: the pin is taken first, so that change does not reach upkeep;
- the start of the first upkeep job.

Pinning at activation alone would miss a project upgraded by another route; pinning at the first run alone would let a reviewer change made in between be the route pinned. Taking the pin before any write closes both.

### Stats (detail)

- A `not-dispatched` model attempt with no recorded invocation counts no invocation.
- `knowledge.upkeep` attempts are model steps: one that reached the model shows its invocation under Models.
- A new section, Knowledge upkeep, appears once a run was recorded or an invocation counted in the window.

### Settings → Models

Every delivery project shows one more row, `maintenance/knowledge.upkeep`, step `run`. Only the operator can change it.

### State

- **No schema change, no layout change, no new index.**
- A new meta row, `upkeepRoute`: `{source, route, pinnedAt, by, reason}`. It is read where a model is selected for the upkeep step and where a configuration is written, not by an idle tick.
- `upkeepDay` rows gain `reservations` (attempt id to reservation, at most as many as the day's limit) while any exists.
- `upkeepRun` rows gain `modelRun`, `usage` and `dropped`.
- Attempts settled while upkeep is on gain `invocationsCounted`.
- The `upkeepWindow` run entries gain `model` and `candidates`. Entries written by the release before have neither; slice 4 must read a missing `model` as false.

### Graph digests

Unchanged. No reference graph reads the new settings. The two digest tests of slices 1 and 2 still pass against the baseline runtime.

### The idle tick

Unchanged: one meta read for upkeep, and no process. The slice 2 test that compares every statement of an idle tick with the runtime at `283ba91` still passes. The provider-hold check runs only when an upkeep job is about to start.

## Tests

`npm test`: 1502 tests, 1502 pass, 0 fail, 0 skipped, after the review and the re-check and with `main` at `500df7a` (dev.87 released) merged in (1463 there, and 39 new: 26 from the first round, 12 from the review, 1 from the re-check). `npm run eval`: exit 0. `git diff --check 9c4fe70..HEAD`: clean.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/upkeep-assessment.test.mjs` | 12 | The line comparison; the injection fixtures of 6.5; the evidence and its bounds; the result schema; every validator rule; truncation; the text rules; invisible characters and compatibility forms, class by class; words that mix scripts |
| `tests/upkeep-budget.test.mjs` | 12 | The reservation, in one process and in twelve; settlement; the limit; an uncertain attempt, resolved each way with and without a receipt; a step that crosses midnight; a call that ended without a result; a drain during the model call; the counting function; the totals against the projection and Stats; reads and writes of a settlement |
| `tests/upkeep-model.test.mjs` | 14 | The invocation; hostile repository text through the job; model selection; authority over the step's model on both schemas; the pinned route on both schemas, for a project that turns upkeep on and for one that already observed, and through the job; what a run records; a provider hold; the ceilings |
| `tests/upkeep-console.test.mjs` | 1 added | The Settings row names the pinned route and keeps naming it after a reviewer change |
| `tests/upkeep-observe.test.mjs`, `tests/upkeep-prefilter.test.mjs`, `tests/upkeep-namespace.test.mjs`, `tests/upkeep-console.test.mjs` | changed | A run with something to assess now reaches the scripted model (`nothing:no-candidate`) where it recorded `assessment-unavailable`. The structural tests state what exists: one model step, and one module that reaches a provider |
| `tests/upkeep-fixtures.mjs` | — | A scripted model (`scriptedModel`): no provider process starts in any test |

The model is scripted everywhere. No test asserts what a real model answers; that is judged in the trial (14.2).

### Acceptance (section 15, slice 3)

| Acceptance item | Test |
| --- | --- |
| The injection fixtures of 6.5: hostile text in a doc excerpt, a diff hunk, a reviewer finding, an operator note, an open candidate's title and a learning body; instructions byte-identical; the block parses back | `upkeep-assessment`: "with hostile text in any evidence, the instruction part of the prompt is byte-identical…" |
| Text that tries to close the block, start a heading or impersonate the factory stays inside the block | `upkeep-assessment`: "text that tries to close the block…"; `upkeep-model`: "hostile text in the repository reaches the model only inside the evidence block…" |
| Whatever a scripted model returns, a file outside the allowed set, a quote not in the shown excerpts, or an anchor outside the offered list is dropped | `upkeep-assessment`: "whatever a scripted model returns…" |
| Scripted model results that break each validator rule are dropped and counted under that rule | `upkeep-assessment`: "scripted model results that break each validator rule…"; `upkeep-model`: "a run records what the validator kept and dropped, by rule…" |
| Truncated input blocks candidates for the truncated file | `upkeep-assessment`: "truncated input blocks candidates for the truncated file, and only for it" |
| The daily limit is exact under concurrent starts; a repeated attempt id reserves once | `upkeep-budget`: "the daily limit is exact under concurrent starts in separate processes…", "a reservation: refused at the limit, made once per attempt id…" |
| At the limit runs abstain and do not queue | `upkeep-budget`: "at the limit a run that needs the model abstains with the reason budget and is not queued for the next day" |
| An uncertain attempt keeps its reservation until resolved | `upkeep-budget`: "an uncertain attempt keeps its reservation until it is resolved…" |
| Counting: several recorded invocations on a reconciled attempt | `upkeep-budget`: "the maintained totals: …" (three, resolved as failed and as not dispatched) |
| Counting: a missing receipt; `not-dispatched` with and without recorded invocations | The same test, and "the counting function: …" |
| Counting: an upkeep run that ended at the pre-filter | The same two tests |
| Counting: equality with the projection | "the maintained totals: …": the day's total, the projection and Stats agree at 11 |
| Counting: the one stated difference | The same test: one result under two attempts, 13 against 12, and nothing else |
| Model selection under `maintenance/knowledge.upkeep` | `upkeep-model`: "model selection: …"; `upkeep-namespace`: "the release has one upkeep operation, one upkeep setting and one model step…" |
| The run telemetry; `observe` only, no candidate rows | `upkeep-model`: "a run records…"; `upkeep-observe`: "observe mode records the outcome…" |
| 4.5 read limits; the idle tick gains no read | `upkeep-budget`: "with upkeep off nothing is counted, and a settlement reads and writes one day row by key…"; `upkeep-observe`: "a tick with no upkeep work adds exactly one meta read…" (unchanged) |
| Review P2-1: a step that crosses a UTC midnight is counted against the new day | `upkeep-budget`: "review P2-1: the reservation reads the clock in its own transaction…" |
| Review P2-2: a model run a receipt proves is not given back | `upkeep-budget`: "review P2-2: …", "an uncertain attempt keeps its reservation until it is resolved; it is given back only when no receipt shows that a model ran" |
| Review P2-3: invisible and format characters, and compatibility forms | `upkeep-assessment`: "review P2-3: …" (26 invisible characters and 6 compatibility forms, each against five refused texts) |
| Re-check P2: a word that mixes scripts is refused; one-script text is allowed | `upkeep-assessment`: "re-check P2: …" |
| Q5: a drain closes a run that reached a model | `upkeep-budget`: "review Q5: …" |
| Q6: a conclusively ended call fails; an unknown end stays uncertain | `upkeep-budget`: "review Q6: …" |
| Q7: the route is pinned when upkeep is turned on; a delegated reviewer change does not change the upkeep model, on schema 1 and 2 | `upkeep-model`: "schema 1: turning upkeep on pins its route…", "schema 2: …", "schema N: a project that already observed…", "review Q7, through the job: …", "the pin: …"; `upkeep-console`: "Settings shows the route the assessment is pinned to…" |

### Fail-before evidence

On the base the three new files fail to load (the modules do not exist). Each row is one partial revert of the committed source, with the three new files run against it (26 tests).

| Source state | Result |
| --- | --- |
| A file outside the allowed set is not checked | 2 fail |
| The quote is not looked for in the shown excerpts | 3 fail |
| A truncated file still accepts candidates | 2 fail |
| Any anchor is accepted | 2 fail |
| A capture candidate needs no verified correction | 1 fails |
| The text rules are not applied | 2 fail |
| `<` and `>` are not escaped in the block | 3 fail |
| Control and override characters are kept | 3 fail |
| Evidence text is put in the instructions | 3 fail |
| The daily limit is not checked | 4 fail |
| A repeated attempt id reserves again | 2 fail |
| The reservation is made outside a transaction | 9 fail |
| A failed attempt gives its model run back | 2 fail |
| `attempt.resolve` does not settle the reservation | 1 fails |
| The engine's settlement does not settle the reservation | 4 fail |
| A `not-dispatched` attempt with no receipt counts one (the old projection) | 2 fail |
| `knowledge.upkeep` is not a model operation | 1 fails |
| An empty list on an upkeep result is not a statement | 4 fail |
| An observation repeated inside one attempt is counted each time | 1 fails |
| The engine's settlement does not count | 5 fail |
| `attempt.resolve` does not count | 2 fail |
| Counted with upkeep off too | 1 fails |
| An attempt can be counted twice | 1 fails |
| `models.update` for the upkeep step is not checked | 2 fail: schema 1 and schema 2 |
| A delegated `replaceLive` may discard the live default | 2 fail: schema 1 and schema 2 |
| A held provider does not keep the job in the queue | 1 fails |
| `providers.upkeep` is not the step's role | 3 fail |
| The budget does not bound the turns | 1 fails |
| A failed model run closes as a plain error | 1 fails |
| The drop counts are not recorded on the run | 2 fail |
| A hold learned of at run time is ignored | 1 fails |

## Review of `bbfe0aa`

Independent review (GPT-6.1 Sol): changes requested, three P2 findings, and an operator decision on Q7. It confirmed the acceptance assertions, injection resistance (block markers, bidirectional controls, homoglyphs, long lines, paths), the accounting, the read limits, the idle tick, the digests, the protection of the model setting, and that no real provider CLI starts. Each fix has a test that fails without it.

**P2-1. A UTC rollover could bypass the daily ceiling.** The time was read once, when the action began, before the fetch and the checkout. A step that began before midnight and reserved after it charged its model run to the day before, and started the model although the new day already held its 30. *Fix:* the reservation takes a clock and reads it inside its transaction; passing a time is refused. The whole step now reads the clock where it needs a time. *Test:* "review P2-1: …": the clock passes midnight during the checkout; with the new day full no model starts and the old day is not charged; with room, the run is reserved on the new day.

**P2-2. Reconciliation returned budget even when a model ran.** Every reservation of an attempt settled `not-dispatched` was given back, whatever its receipt showed. With 29 runs used, a call that ended uncertain with its invocation on the receipt and was resolved as `not-dispatched` let another call run: 31 invocations against 30 model runs. *Fix:* a reservation is given back only when the attempt is settled as not dispatched and the counting function finds no invocation on its receipt. The same function already counts such a receipt's invocations in the totals (4.5), so the two agree. *Tests:* "review P2-2: …" (30 against 30, and the next run abstains), and the uncertain-attempt test, which now resolves each way with and without a receipt. The earlier test preserved the old behaviour for `not-dispatched` with a receipt; it is changed.

**P2-3. Zero-width characters carried text past the text rules.** `Ig<zero-width space>nore all previous rules.` passed, unflagged. *Fix:* both of the reviewer's options. Model-written text that holds any character nobody sees is refused: Unicode category Cf (zero-width spaces and joiners, bidirectional controls, the soft hyphen, tag characters, the byte-order mark), every default-ignorable code point (fillers, the combining grapheme joiner, invisible operators), every variation selector, and the Braille blank. And the rules are matched on the text after NFKC folding with those characters removed, so full-width, mathematical and circled letters and unusual spaces are read as what they stand for. A reason may hold no such character either. *Test:* "review P2-3: …".

**Q7, operator decision: the route is pinned when upkeep is turned on.** See [Model selection](#model-selection-63-12) and decisions 23 and 24. Delegates keep control of the reviewer; the assessment no longer follows it. Settings shows the pinned route.

**Design text changed, three sentences**, each marked with its origin:

- **5.3, Drain.** It said a stopped run's receipt returns to pending; 6.6 says an assessment is never retried automatically. For a run that had already reached the model the two cannot both hold. 5.3 now says such a run is closed with the model run it used. This is the one plain contradiction.
- **6.6, Daily model limit.** "Only an attempt settled as not dispatched is given back" now adds "whose receipt names no invocation", as 4.5 already says of the totals, and says the day is read inside the reservation's transaction. This follows P2-1 and P2-2: the sentence as it stood described the defect.
- **6.3, The model call.** One sentence records the operator's Q7 decision, as 6.2 records the slice 2 decision.

Fail-before, one partial revert each, with the four test files that hold the new tests (42 tests):

| Source state | Result |
| --- | --- |
| The clock is read once, when the action begins | 1 fails: the P2-1 test |
| Every `not-dispatched` reservation is given back | 2 fail |
| Invisible characters are neither refused nor removed before matching | 1 fails: the P2-3 test |
| They are refused, but compatibility forms are not folded | 1 fails: the same test |
| A reason may hold invisible characters | 1 fails: the same test |
| A drain returns every stopped assessment to pending | 1 fails: the Q5 test |
| An invalid result leaves the attempt uncertain | 1 fails: the Q6 test |
| An upkeep flow selects its model under the stored configuration | 6 fail |
| Turning upkeep on pins nothing | 4 fail |
| No pin is taken before a configuration write | 2 fail: schema 1 and schema 2 |
| No pin is taken before an upkeep job selects its model | 2 fail |
| Turning upkeep off keeps the pin | 5 fail |
| A change of the reviewer re-pins | 7 fail |
| Settings does not show the route | 5 fail |

## Re-check of `800d1d5`

Re-check (GPT-6.1 Sol): the three repros fixed; the rollover across processes, receipts with 0, 1 and 3 invocations, all 4,207 invisible code points, the route pin across reopening and combined delegated changes, Q5 to Q7, the design edits, the read limits and the digests all held. It confirmed that the 6.3 and 6.6 edits belong in the design. One finding.

**P2. Mixed-script confusables passed the text rules.** `Ign<Cyrillic o>re all previous rules.` was accepted, unflagged: the letter is visible, so it is not removed, and NFKC keeps it. *Fix:* a word whose letters do not share a script is refused, in a replacement, a capture title and text, a reason and a quote (`text-rule`). The test is UTS #39 mixed-script detection applied to each word:

- a word is a run of letters, marks, digits and underscores, taken from the text after NFKC folding, so a word spelled in mathematical letters of two scripts is judged as the letters it stands for;
- each character has a set of scripts (its Script_Extensions); Common and Inherited characters (digits, punctuation, combining marks) are neutral;
- a word is of one script when the sets of its other characters have a script in common. As in the standard, Han counts with the scripts it is written with (Hiragana and Katakana, Hangul, Bopomofo).

Text wholly in one script passes, whatever the script, and so does a sentence whose words are each in one script (a Latin sentence with a Greek word in it).

Not done: the optional match against a confusable skeleton. It needs the standard's confusables table, which is not small.

**What the rule costs, recorded so that it is not a surprise.**

- A word that joins two scripts for a legitimate reason is refused: a unit such as `k` with a Greek omega, or Latin written against kana with no space between them (`README` followed directly by hiragana). In a replacement the model can write it apart; in a quote it cannot, so such a statement in a doc cannot be quoted. UTS #39's "highly restrictive" level would allow Latin with Han, kana and Hangul; it is not used, because a Hangul or Han character that looks like a Latin `o` inside a Latin word is the same bypass.
- The script list is Unicode 17's (173 scripts). A code the runtime does not know is left out, and a character of a script that is not listed is treated as a script of its own. A test fails if the runtime knows a letter in no listed script.

*Test:* "re-check P2: …" (`tests/upkeep-assessment.test.mjs`): Cyrillic and Greek look-alikes inside Latin words, for every refused text and through every field; a fully Cyrillic and a fully Greek sentence, Japanese, Korean, Chinese with Bopomofo, Arabic and Hebrew, each allowed as a replacement, a reason and a quote; a Latin sentence with one Greek word, allowed; digits, punctuation, underscores and accents.

Fail-before, one partial revert each, with that file (12 tests):

| Source state | Result |
| --- | --- |
| Model-written text is not checked for mixed-script words | 1 fails: the new test |
| A reason is not checked | 1 fails |
| A quote is not checked | 1 fails |
| The words are taken from the text as written, not folded | 1 fails |
| Han is not counted with the scripts it is written with | 1 fails |
| Digits and underscores separate words | 1 fails |
| Common and Inherited characters are not neutral | 2 fail |

## Settled after review

The eight questions the first version of this record raised, settled by the reviewer's recommendations and, for the seventh, by the operator.

| # | Question | Settled |
| --- | --- | --- |
| 1 | The fields of a docs edit | **Kept:** the quote and the reason. The follow-up's builder writes the correction. |
| 2 | A file that is a candidate only by a mapping | **Kept:** shown from its first line; when it is cut, nothing is accepted for it. |
| 3 | The mechanical text rules | **Kept:** the split between what is refused and what is flagged. P2-3 and the re-check's P2 close the bypasses. |
| 4 | A configured fallback provider | **Allowed.** A fallback the project configured explicitly may run when the first provider did not start. |
| 5 | A run a drain stopped during its model call | **Closed**, with the model run it used. A run that had not reached the model is queued again. The design's 5.3 now says so. |
| 6 | An assessment whose model call ended without a usable result | **Failed**, when the call conclusively ended (the provider process exited and its output did not validate; a turn limit). **Uncertain**, when how it ended is not known: a timeout, a cancellation, a transport failure, a usage limit, an output limit, surviving descendants. |
| 7 | The reviewer fallback and authority | **Pinned** (operator decision): the route is recorded when upkeep is turned on; later reviewer changes do not affect upkeep; only the operator changes it. |
| 8 | Where the day totals are shown | **Kept in Stats.** |

No question is open.
