# dev.94: the dev.93 readiness re-test findings R1–R3

Three console findings from the dev.93 readiness re-test:

- **R1 (console, wrong).** At 390 px, a tap on one flow's bar on the Timeline opened a different flow. It reproduced twice. On a desktop the same bar opened the right flow.
- **R2 (console).** In a busy flow's execution timeline (43 attempts), 11 attempt bars at 390 px and 16 at 320 px could not be tapped, because a neighbouring bar took the tap. Each target was 10.5 × 20 px. The keyboard reached every attempt, and on a desktop every bar worked.
- **R3 (console).** Two smaller gaps:
  - Overview's Queue figure had no "Open Queue" link.
  - An expanded queue entry's "Admission held" ended "(task.models); project held" and did not name the pause.

This is a local implementation record, not a release, activation or live qualification claim. No model session or provider CLI was started.

## Action needed

- **Nothing to migrate.** No schema, graph, configuration key, command or project-service read changed, and the graph digests are unchanged.
- **The checklist's selectors for timeline bars changed.** A flow's bar on the Timeline was a link, `a.slot-flow`. It is now a drawn `span.slot-flow` with `data-flow`, under a link `a.slot-hit` or a group. An attempt's bar was a `button.bar`. It is now a drawn `span.bar` with `data-attempt`, under a `button.bar-hit` or a group. `docs/qualification/console-browser.md` names the new selectors. A browser script that clicked the old elements by role or class must use them.

## R1 and R2: the cause

Both timelines draw a bar at its true place and width. On a phone that is often a pixel or two.

- **Project Timeline.** Twelve hours fit on a track about 250 px wide at 390 px, so a minute is a third of a pixel. The flow in the report ran 01:02–01:05 UTC, and the next flow in its slot started at 01:06. Its bar was 1.1 px wide, beside a 0.75 px bar a third of a pixel away. A tap, or a click at its centre, landed on the neighbour, which was later in the page and so on top.
- **A flow's execution timeline.** Each attempt bar had 0.35 rem of padding on each side. So a one-second attempt was drawn 10.5 px wide, however short it was. That is the reported 10.5 px target. Neighbouring bars overlapped, and the later one took the tap.

On a desktop the tracks are four times wider, so the bars in the report were far enough apart. They were still not reliable there: on main, 4 of the 54 Timeline bars at 1440 px opened another flow.

## R1 and R2: the fix

The bars are now only drawn, and a separate layer of tap targets takes the taps (`tapTargets` and `tapLayer` in `console/ui/timeline.mjs`). Both timelines use it.

- **Targets.** Each flow or attempt gets a target at least 44 CSS px wide on a phone or touch screen, and 8 px with a mouse. `tapPx` decides which, from `(max-width: 780px), (pointer: coarse)`. The target is centred on the bar and fills the lane, which is 44 px tall at phone width.
- **No overlaps.** Bars whose targets would overlap share one target: a group. It works like the grouped event markers. Its summary shows the count and is labelled "N flows close together; show them below the track" (or "N attempts …"). Its list opens in a panel below the track, because the slot track and the flow's chart clip anything outside them. On the Timeline each flow in the list is a link by title. In a flow's execution timeline each attempt is a button that selects it, with `aria-pressed` set on the selected one.
- **Wide bars keep their own target.** A bar at least three targets wide that overlaps no other bar keeps its own extent as its target. A short bar beside it may reach into it by less than one target, and is stacked above it. So the wide bar's centre is always its own.
- **An attempt is one target.** Its prepared and running bars both select it.
- **Laid out for the real width.** The layer is laid out for the track's width in pixels, as the axis ticks are since dev.93 (`fitTicks`). It is laid out again whenever that width changes. The width last measured for each kind of track is kept, so the page rebuilt by the refresh every few seconds starts with the same targets. An open group therefore stays open. When a resize changes the groups, an open group stays open as the new group that holds the same bars.
- **Drawn bars.** They take no pointer events and are hidden from assistive technology. The target carries the flow's or attempt's accessible name, as the bar did. A bar with no label inside it has no padding, so it is drawn as wide as its time (at least 4 px), not 10.5 px. On the Timeline, a flow's per-step times move from each segment's tooltip into the flow target's tooltip.
- **The count badge** takes no taps. On a desktop a group's target can be narrower than its count, and the badge then lies over the next target.

Keyboard use is unchanged in kind. Tab reaches each target: a flow's link, an attempt's button or a group's summary. Escape, outside clicks and navigation close a group as they close a grouped marker.

The only change on a desktop is that bars less than 8 px apart now share a group. With the trial's data at 1440 px that is 10 groups on the Timeline and 3 in the busy flow. The review of 3e4fdda recommended keeping this, and it is kept.

### How it was measured: headless Chromium, offline

The check used `/usr/bin/chromium` in headless mode, driven by Playwright from a scratch script outside the repository. The script served the console's static files and answered its `/api/` reads from the responses recorded in the readiness re-test. These were the project list, the 12 h timeline and the busy flow's detail, the trial's real data. That is the one place requests were answered by the script. It is fine for this check, but it is not the qualification checklist, which forbids it.

Phone runs used a 390 or 320 px viewport with touch input (`isMobile`, `hasTouch`, a touchscreen tap). The desktop run used 1440 px with mouse clicks. The automatic refresh was turned off for the counts, because a tap that lands while the page is being rebuilt reaches nothing, as with any control. A separate run with the refresh on opened a group, waited through two refreshes, and found it still open with its list.

For every drawn bar, the script:
1. tapped the centre of the bar's visible box;
2. if a group opened, tapped that bar's entry in the list;
3. recorded the flow or attempt the address then named.

| Every bar tapped at its centre | main (0120fd6) | This change |
| --- | --- | --- |
| Timeline, 54 flow bars, 390 px | **13 open another flow**, including the reported one (`a7eceaf3…` opened `80dbf2f1…`) | 54 of 54 |
| Timeline, 320 px | **15 open another flow** | 54 of 54 |
| Timeline, 1440 px | **4 open another flow** | 54 of 54 |
| Busy flow, 86 bars of 43 attempts, 390 px | **11 attempts unreachable** (22 bars) | 86 of 86 |
| Busy flow, 320 px | **16 attempts unreachable** (32 bars) | 86 of 86 |
| Busy flow, 1440 px | 86 of 86 | 86 of 86 |

On main the counts match the report: 11 and 16 of 43 attempts. One example is plan attempt `a90e9e77…`, under `da07f06c…`.

Measured on this change, with every group closed:

| | Timeline 390 / 320 / 1440 px | Busy flow 390 / 320 / 1440 px |
| --- | --- | --- |
| Targets (of which groups) | 16 (12) / 9 (6) / 34 (10) | 16 (11) / 16 (11) / 40 (3) |
| Narrowest target | 44.4 / 44.4 / 8.5 px | 44.4 / 44.3 / 8.5 px |
| Shortest target | 44 / 44 / 24 px | 44 / 44 / 32.8 px |
| Overlapping targets | 0 | 0 |
| Page overflow | 0 | 0 |

The trial's data has no wide bar beside short ones at phone width. A synthetic timeline adds one: a nine-hour flow with a short flow a minute before it and two a minute after it. At 390 and 320 px, all 46 bars opened their own flow. The two groups reached into the wide bar, and its centre still opened it.

**R3 in the same browser** (the recorded data, with admission paused and one context task held):
- The Queue figure reads "Queue | 1 | queued tasks · 1 held on its own | Open Queue". Its link is 72 × 44 px at 320 and 390 px and opens `queue?task=upkeep:context:…`, as the other two links do.
- The queue entry's "Admission held" ends "… (task.models); the whole queue is held: admission is paused".
- No page overflowed.

## Review of 3e4fdda, P2: a refresh lost focus inside an open group

**Repro (review).** At 320, 390 and 1440 px, open a group with Enter, Tab to an entry in its list, and wait for the refresh, every 10 seconds by default. The group stayed open, but focus moved to `<body>`.

**Cause.** The refresh rebuilds the page, then `restore` (`console/ui.mjs`) gives back what was focused and what was open, in that order.
- **Panel groups.** For a group whose list sits in a panel below the track, reopening it only set `open`. The panel was filled by the group's `toggle` handler, which the browser runs later. So when `restore` looked for the focused entry, it did not exist yet.
- **The Timeline's events lane.** Its list is inside the group, so the entry existed. But it was inside a group not yet reopened, and a control in a closed `details` cannot take focus.
- **A flow's own link on the Timeline** (`a.slot-hit`) had no focus key, so `restore` could not find it. The old `a.slot-flow` had none either.

**Fix.**
- **A group reacts to `open` at once.** A grouped marker's `open` property (`openAtOnce`, `console/ui/timeline.mjs`) does what its toggle handler does as soon as script sets it: a refresh restoring the group, a resize carrying it over, or a close. It wraps the element's own `open`, so the `[open]` attribute and the native toggle still work.
- **The later toggle event keeps the panel.** `showBelow` leaves a panel the group already shows as it is. The toggle event that follows therefore does not rebuild the entries, nor drop the one now focused.
- **`restore` reopens sections first**, then restores focus. That covers both kinds of list.
- **A flow's own link** has the focus key `slot-flow:<flow id>`.

**Measured** in headless Chromium against the recorded data, with the refresh on. For each group kind, the script opened a group with Enter, tabbed into its list, waited 12.5 seconds through a refresh, and read `document.activeElement`:

| Group | 3e4fdda at 320 / 390 / 1440 px | This change |
| --- | --- | --- |
| Timeline flow group (`slot-cluster`) | **`<body>`** at all three | the same entry at all three |
| Flow attempt group (`bar-cluster`) | **`<body>`** at all three | the same entry at all three |
| Timeline events group (`tl-ev-cluster`) | **`<body>`** at all three | the same entry at all three |
| Flow events group (`marker-cluster`) | its list holds text only, nothing to focus | unchanged |

Every group stayed open in both versions. The tap measurements were then taken again on this change: 54 of 54 flow bars and 86 of 86 attempt bars at 390, 320 and 1440 px, targets at least 44.3 px on a phone and 8.5 px on a desktop, with no overlaps.

**Tests** (`tests/dev94-r-items.test.mjs`), each failing on 3e4fdda:
- **Opening fills the panel at once.** Setting `open`, as `restore` does, fills the panel immediately for an attempt group, a flow-chart event group and a Timeline flow group. The toggle event that follows leaves the entry in place. Closing empties the panel.
- **Order.** `restore` reopens sections before it restores focus.
- **Focus key.** A flow's own target on the Timeline has one.

## R3

- **Overview's Queue figure** has an "Open Queue" link (`kpi` takes an optional action). With exactly one task held on its own, the link opens Queue at that task, as the "Needs attention" item and the "Admission controls" line do. Otherwise it opens Queue itself. On a phone the link is 44 px tall.
- **"project held".** An admission observation records the reason "project held" when a pause, a recovery hold or a retention hold stops admission. The queue entry shows the observation's reasons. It names a hold by matching the task's structured holds, and the snapshot's queue tasks carry none, so the bare reason was shown. `reasonNodes` (`console/ui/admission.mjs`) now names it from the holds the project reports now, in Overview's words: "the whole queue is held: admission is paused". Overview's wording table, `QUEUE_HOLD`, moved to `admission.mjs` so both places use it. A project service without queue status gives only its flags; the same words are used for those. If nothing holds the project any more, the entry says "the whole queue was held then (no project-wide hold is in place now)", because the observation is older than the page.

## Checklist

`docs/qualification/console-browser.md`:

| Check | Finding |
| --- | --- |
| Pass A step 1: the Queue figure's "Open Queue" | R3 |
| Pass A step 3: tap every flow bar's centre at 390 and 320 px, and check the targets' sizes and overlaps | R1 |
| Pass A step 5: the queue entry names the project-wide hold | R3 |
| Pass B step 2: tap every attempt bar's centre at 390 and 320 px, and on a desktop | R2 |
| Pass A step 3: focus on an entry in an open group survives a refresh | Review of 3e4fdda, P2 |

## Tests

`tests/dev94-r-items.test.mjs`:
- **Targets.** Bars a pixel apart share a target at phone width and get one each with a mouse. A wide bar keeps its own target and centre. A gap between two wide bars is handled. Edges and a track narrower than one target are handled. A bar drawn wider than its time is judged by what is drawn.
- **Invariants over 400 random arrangements and seven track widths.** Every bar has exactly one target, and the target holds its centre. Each target is at least the minimum width. Targets that are not a wide bar's own never overlap. A wide bar's centre is its own.
- **The project Timeline.** The bars are drawn only. A group lists and links each of its flows in the panel below the track. A lone flow gets a link.
- **A flow's execution timeline.** A group lists each attempt as a button that selects it. The other attempts get a button each. The selected attempt is marked in the list.
- **The layer.** It is laid out again for the measured width. An open group stays open across a resize. A rebuilt page starts from the last measured width.
- **CSS.** The bars take no pointer events, the count badge takes none, unlabelled bars have no padding, and the targets are 44 px tall on a phone.
- **R3.** The Queue figure's link, with and without a held task. The queue entry's wording with a pause, with several holds, with only the snapshot's flags, and with no hold left.

`tests/console-browser-defects.test.mjs` finds an attempt's drawn bar by `data-attempt`, since its accessible name is now on the target.
