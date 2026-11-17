# dev.93: the dev.92 readiness re-test findings Q1–Q5

Five findings from the dev.92 readiness re-test:

- **Q1 (console, wrong).** A flow's page said "No role has cited a learning of this cycle yet." `status --flow` for the same flow listed the planner and builder applying the learning and the reviewer following it.
- **Q2 (console, wrong).** A held context task's page said "Nothing is admitted while the queue is held". The hold was on that task only, and later tasks did start.
- **Q3 (console).** Overview said "Project admission is open" and nothing about the held context task.
- **Q4 (console).** Two layout problems at phone width:
  - Queue was 404 px wide at a 390 px viewport, because the hold banner's long task id (`upkeep:context:…`) did not wrap.
  - A flow's timeline axis labels overlapped.
- **Q5 (docs).** About 15% of the trial's invocations were attributed to upkeep. Only 8 of those 20 were assessments; the rest were the follow-up tasks' own planner, builder and reviewer calls. The ceiling's window was not full, so nothing was suspended.

This is a local implementation record, not a release, activation or live qualification claim. No model session or provider CLI was started.

## Action needed

- **Nothing to migrate.** No schema, graph, configuration key or counting changed, and the graph digests are unchanged.
- **The console's flow read now carries `learningCitations`.** A console on this release, in front of a project service on dev.92, shows the citations. In front of an older service it falls back to the flow record, as before.
- **Health has one new field, `upkeep.invocationShare`.** It is present while upkeep is on (observe or propose), and `null` while it is off. Health then reads eight more rows, each by key.

## Q1: the flow page and `status --flow` read the same citations

**Cause.** The project service's flow detail (`/v1/flows/:id`) sends `learningCitations`. It builds that list with `learningCitationsOf`, the function `status --flow` uses. The console server (`console/console.mjs`) passes on only the fields it lists, and `learningCitations` was not listed. So the page fell back to `flow.learningCitations` on the raw flow record.

That fallback works for a flow whose citations were recorded per attempt. The trial's flow had been planned before the upgrade. Its record had no `learningCitations` array, so `status --flow` read the citations from the flow's plan, build and review results. The page had nothing to read and said nobody had cited anything.

**Fix.** `learningCitations` is added to the console's projection of a flow read. The page now reads what `status --flow` reads, and keeps its fallback to the flow record for an older service.

## Q2: a hold on one task is described as that task's

`approvalState` (`console/ui/plan.mjs`) builds the task page's opening sentence. It now separates two kinds of hold. A hold on the whole queue, or on the task's kind of work or target, still reads "Nothing is admitted while the queue is held: …". A hold with `scope: 'task'` on this task now reads:

> This task is held on its own, not the queue: tasks queued behind it still start. Context task … is not started: … To start it, run that checklist for codex on this host and, once it passes, add it to upkeep.context.qualifiedProviders (config update, operator only); or route the task's model steps to a listed provider (task.models). Automatic admission starts it once this hold is lifted.

The hold's own text already names the remedy, so the sentence quotes it whole. With both kinds of hold, the queue's comes first, then "This task is also held on its own: …". The sentence ends "Automatic admission resumes once the hold clears, and starts this task once its own hold is lifted too." `queueHoldRows` returns each hold with its scope. `queueHolds` keeps its old shape (texts) for its other callers.

## Q3: Overview counts the tasks held on their own

`heldTaskIds` (`console/ui/overview.mjs`) reads the queue status's holds with `scope: 'task'`. That covers a context task held for an unqualified provider, and a task the automatic claim could not start. When there is one or more, Overview shows the count in three places:
- the Queue figure, as "queued tasks · 1 held on its own";
- a "Needs attention" item, "1 queued task is held on its own";
- a line in "Admission controls" under the admission state, "1 queued task is held on its own: each hold is on that task only." followed by what the rest of the queue does.

The item and the line link to Queue. With one held task, the link opens Queue at that task. "Project admission is open" is unchanged, because it is true.

**What the rest of the queue does** (`restOfQueue`, after the review of e58abd1, P2). The item and the line say "The rest of the queue still starts." only when nothing else stops admission. Otherwise they say:

| Other hold (queue status) | What they say |
| --- | --- |
| On the whole queue: a pause or drain, recovery, retention, spending, doctor, a stalled launch, a failed claim with no task | "The rest of the queue is held too: admission is paused." (each hold named) |
| On change work only: main verification, a merge in flight, a target sync | "Change and document tasks in the rest of the queue wait too, because main is not verified green." |
| Automatic admission off | "Automatic admission is off, so the rest of the queue starts only when dispatched." |
| An older service with no queue status | The snapshot's own pause, recovery or doctor hold, as the task page reads it |

A hold on change work and admission off can both apply; then both are said.

## Q4: long ids and axis labels at phone width

- **Banners.** `.notice` now has `min-width: 0; overflow-wrap: anywhere`, so a long id breaks inside the banner instead of widening it. This covers every notice:
  - Queue's "A queued task is held." and "The queue is held.";
  - Health's context task, follow-up and suspension notices;
  - the task detail.
  The same rule was added to an attention item's text and to the KPI tiles, where a long id could also appear. Inbox cards and records already wrapped.
- **Axis labels.** Labels were placed at a fixed count of about six, whatever the width. `axisTicks` (`console/ui/timeline.mjs`) now picks the finest step whose labels fit side by side on the track.
  - **The track's rendered width** (after the review of e58abd1, P3). The first version estimated the width from the viewport. In the flow dialog the real track is far narrower than that: 102.5 px at a 320 px viewport, where the estimate was 180 px, and 72.5 px in the reviewer's run. So labels still overlapped there. `fitTicks` now draws the ticks for the estimate first, then observes the track with a `ResizeObserver` and draws them again whenever its laid-out width changes: its first layout, a window resize, a zoom. This holds in every container. The observer lets go once the track has left the page. Without `ResizeObserver` (the fake DOM in tests) the estimate stays.
  - A label's width is judged at 8 px per character plus a 16 px gap.
  - A track too narrow for two labels keeps one: the first tick of the finest step that has any.
  - A desktop keeps the step it had. A phone gets a coarser step: the dialog's two-minute flow shows one label at 320 px and three (15:03, 15:04, 15:05) at 390 px, instead of five to the second.
  - The project timeline's slot axis uses the same rule, from its own rendered width.

### How it was measured: headless Chromium, offline

The check used `/usr/bin/chromium --headless=new`, driven over the DevTools protocol, with no request intercepted. It ran against a real project service and console from the test fixtures, with:
- a held context task, `upkeep:context:` plus 32 hex characters;
- a two-minute flow of three attempts.

The scratch script is not part of the repository. For each page it recorded `document.documentElement.scrollWidth`, each axis's rendered width and whether any two of its labels' boxes overlapped. The flow ran 170 seconds, as in the review.

| Page | `main` (c4fa9fe) at 320 / 390 px | This change at 320 / 390 px |
| --- | --- | --- |
| Overview | 320 / 390 | 320 / 390 |
| Queue, held context task | **403 / 404** | 320 / 390 |
| Health | 320 / 390 | 320 / 390 |
| Task detail of the held task | 320 / 390 | 320 / 390 |
| Flow dialog axis (track 102.5 / 172.5 px) | **5 labels, 4 overlaps** at both | 1 label / 3 labels, no overlap |
| Project timeline slot axis (track 265.5 / 335.5 px) | 6 labels, no overlap | 4 / 6 labels, no overlap |

**A live resize**, with the flow dialog open and no reload:

| Width | e58abd1 (estimate at load) | This change |
| --- | --- | --- |
| 1440 px (track 894 px) | 5 labels, no overlap | 5 labels, no overlap |
| then 320 px (track 102.5 px) | **5 labels, 4 overlaps** | 1 label |
| then 390 px (track 172.5 px) | **5 labels, 4 overlaps** | 3 labels, no overlap |
| then 1440 px | 5 labels, no overlap | 5 labels, no overlap |

At 768 and 1440 px the flow axis is unchanged: five labels to the second, with no overlap.

The unit tests use the fake DOM, which has no layout. They check:
- the CSS rules;
- that the hold banner carries the long id as text;
- that adjacent tick labels are at least a label's width apart at 320, 390, 768 and 1440 px.

## Q5: what the upkeep share counts, in Health and the docs

**The counting is unchanged.** An invocation is upkeep-attributed when its flow is the upkeep job's own, or its task carries the factory-written upkeep marker (`upkeepAttributed`, design 4.5 and 8.3). That includes every planner, builder and reviewer call of a docs follow-up, a context, check or learning task, and a retirement task.

**Health** (`operations/views.mjs`, `console/ui/operations.mjs`):
- **`upkeep.invocationShare`.** `invocationShareStanding` (`operations/upkeep-ceilings.mjs`) computes it from the same rows and window rule the ceiling uses, but judges nothing. It gives:
  - the counts and the share;
  - the 10% ceiling;
  - whether the window is full, and if not, the first UTC day it is judged;
  - whether the share reaches the ceiling.
- **Reads.** The window row and seven `upkeepDay` rows, each by key, with no JSON read over `records.data`. They happen while upkeep is on, in observe mode too, because the ceiling judges the share there as well (operator decision after the review of e58abd1). With upkeep off, Health still reads no day row. The read-count tests now allow exactly these eight:
  - `tests/upkeep-health.test.mjs`: in observe mode the view's own reads are eight, each `SELECT data FROM records WHERE kind=? AND id=?`, and never a finding;
  - `tests/upkeep-records.test.mjs`: on the large and the small history alike, "Health with upkeep on" reads eight statements by key, and "Health: no record read of its own" (upkeep off) still reads none.
- **The Knowledge upkeep card** reads, for example: "Upkeep share of model invocations: 20 of 131 in the last 7 complete UTC days (2026-11-09 to 2026-11-15, UTC), 15.3%; the ceiling is 10%." It then says one of four things:
  - counting has not started;
  - the window is not full and when it is first judged;
  - the share is below the ceiling;
  - the share reaches the ceiling and the next run to close suspends the model call and docs.
- **What counts, and small projects.** A second line says what counts: each assessment's own call, and every planner, builder and reviewer call in the follow-up tasks. It says that a project with little other work may reach 10%, that this is expected, and that you review the share and lift the suspension.

**Docs.** `docs/operations.md`:
- corrects "`upkeepInvocations` for the upkeep job's own attempts" to the marker rule;
- adds a paragraph after the ceilings table on what the share counts, the trial's numbers, small projects, and what Health shows.

## Checklist

`docs/qualification/console-browser.md` gains checks for each finding:

| Check | Finding |
| --- | --- |
| Pass A step 1: the held-task count on Overview | Q3 |
| Pass A step 5: a task-scoped hold described as the task's | Q2 |
| Pass A step 9: the share line in Health | Q5 |
| Pass B step 2: what each role cited, compared with `status --flow`, including a flow planned before an upgrade | Q1 |
| Pass D step 3: long ids in banners, and axis labels at phone width | Q4 |

## Tests

All in `tests/dev93-q-items.test.mjs`:

| Finding | Test |
| --- | --- |
| Q1 | "Q1: the flow page shows the citations status --flow returns, read through the project service and the console, for recorded citations and for a flow planned before they were recorded". It runs a real project service and console, compares the console's `learningCitations` with `status --flow`, renders the page from the console's response, and reproduces the old reading without the list. |
| Q2 | "Q2: a held context task's page says the hold is on that task, with its remedy, not that the queue is held". It also covers the case where the queue is held as well. |
| Q3 | "Q3: Overview counts the queued tasks held on their own and links to Queue; with none it says nothing more" |
| Q3, review P2 | "Q3 review: with any other hold that stops admission, Overview never says the rest of the queue still starts". It checks each whole-queue hold, each change-scoped hold, several at once, admission off, and an older service. |
| Q4, banners | "Q4: a banner, an attention item and a KPI break a long id inside themselves instead of widening the page". It uses the fake DOM and checks the CSS rules; the widths were measured in Chromium, above. |
| Q4, axis | "Q4: the flow axis shows only as many time labels as fit side by side at the track width", including the review's 72.5 px, 170 s case |
| Q4, review P3 | "Q4 review: the axis is drawn for the track's rendered width, again on every resize, and lets go once the track has left the page". It uses a stub `ResizeObserver` on the rendered flow page; the real widths were measured in Chromium, above. |
| Q5 | "Q5: Health shows the seven-day upkeep share against its 10% ceiling, says what it counts, and that a small project may reach it" |
| Q5, the window not yet full, reads, observe mode, off, older service | "Q5: before the window is full Health shows the share so far and the day it is first judged; it reads the window row and seven day rows by key, in observe mode too, and nothing while upkeep is off" |

Existing tests are unchanged, including the G23 j "Nothing is admitted while the queue is held" assertions for queue-wide holds and the dev.92 budget read-count test. Two Health read-count tests changed, as decided: see Q5.

## Open questions

- **Tick label width is an estimate** (8 px per character). The track width is now measured, but a label's width is not. It was checked in Chromium with the console's own font, where a five-character label is about 35 px against the 56 px allowed. A much wider system font could still crowd the labels, though not at the widths measured.

## Review

The GPT-6.1 Sol review of e58abd1 found one P2 and one P3. It confirmed:
- Q1's allowlist is complete;
- Q2's wording covers every combination of holds;
- Q4 leaves no other overflow;
- Q5's figures match the ceiling's;
- safe DOM text, read limits and digests are unchanged.

| Finding | What changed |
| --- | --- |
| P2: Overview said the rest of the queue still starts while admission was paused | `restOfQueue` qualifies it for every other hold, as in Q3 above |
| P3: axis labels still overlapped at 320 px in the flow dialog, whose track is narrower than the estimate | Ticks are chosen from the track's rendered width and chosen again on resize, as in Q4 above |
| Decided: show the share line in observe mode too | Q5 above; two read-count tests allow the eight bounded key reads |
