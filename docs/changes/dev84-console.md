# dev.84: console findings from the dev.83 real-browser pass

Implementation from `main` at `be3f9d0` (dev.83 qualification record). This is not a release. Findings are numbered as in the dev.83 re-test: H3, H5 and H7 are console defects, and H4 and H6 are checklist defects. The repository stays project-neutral: tests and documents use fictional projects only.

Tests: `tests/console-dev84.test.mjs` (8 tests). Existing assertions changed in `tests/console-dev83.test.mjs` (Queue now shows a hold's times as `<time>` in two places), `tests/console-flow-slots.test.mjs` (the category-wait text links its flows) and `tests/console-views.test.mjs` (the console forwards the flow's slot state). `tests/fake-dom.mjs` gains `contains`.

## H3: a flow's detail did not say it was parked, or whether it held a slot

**Problem.** A parked flow's detail read only "State: waiting", "Current step: decide", "Finished: Not finished". Canonical state had `parked: true` and `holdsSlot: false`. Only Queue's Flow slots card said so.

**Fix.**
- `operations/capacity.mjs`: `flowSlot(state, flow)` gives one flow's place, from the same `slots()` state that admission, queue status and the Flow slots card use. `flowCapacity(store, flow)` reads it for one flow. The states are:
  - `working`: holds a slot (running, ready, or waiting on anything but an answer);
  - `parked`: waiting on an answer within `policy.maxParkedFlows`, holds no slot;
  - `parked-holding`: parked beyond that limit, keeps its slot;
  - `waiting`: answered and waiting for a slot, with `position`, `of` and the same `reason` text `slotWaitView` gives the Queue card;
  - `category`: answered and waiting only for a place in its category while its pool has a free slot, with the category's counts;
  - `stopped`: holds a slot.

  Each carries `holdsSlot`, the pool, and the pool's slots in use and maximum. It is null for a finished flow and for planning, maintenance and task flows.
- `service/project-service.mjs`: the flow read (`/v1/flows/:id`) adds `capacity`. A failure to compute it gives null, not a failed read.
- `console/console.mjs`: `capacity` is added to the flow read's forwarded fields. Without this the console would drop it on the wire.
- `console/ui/timeline.mjs`: "Flow summary" gains a "Flow slot" line after "State": a chip with the state ("Working", "Parked on an answer", "Answered, waiting for a slot", "Answered, waiting on its category", "Stopped"), then "holds a slot" or "holds no slot", then one sentence. For a waiting flow the sentence is the project's own reason, with its position and the flows holding the slots, each linked.
- The console does not derive the state. With a project service that predates this, it looks the flow up in the queue status's `parked` and `waiting` lists, which the same derivation produced, and shows nothing otherwise.

**Tests.** "H3: one flow's slot state …" builds each state from a live flow set: working, stopped, parked, parked beyond a limit of 1, waiting at position 1 of 1 (with the Queue card's reason), and waiting only on a full category. It also checks the finished and planning cases and agreement with `capacityView`. "H3: the project service's flow read …" runs a real service: a flow at its question reads `parked` without a slot, then `stopped` with one, then null once completed. "H3: the flow summary …" renders each state, a linked holder in the waiting reason, and the fallback for an older service. `console-views` checks that `capacity` reaches the browser through the console.

## H5: Escape did not close a grouped Timeline marker's list

**Problem.** The grouped marker (a `<details>` disclosure since dev.83) opened by tap, click and keyboard, and Enter closed it. Escape left it open, on desktop and phone.

**Fix.** In `console/ui/timeline.mjs`, `markerGroup` now behaves like a popover:
- **Escape.** With focus on the summary or on a link in the list, Escape closes the list and focuses the summary. It calls `preventDefault` and `stopPropagation`, so inside the flow detail modal (the execution timeline's groups) the first Escape closes only the list. A second Escape, with the list closed, is left alone and closes the modal as before.
- **Outside click.** One document click listener, in the capture phase, closes every open group that does not contain the click. Capture runs before a control's own handler re-renders the page, so a window or zoom choice does not bring the group back as open. Opening one group closes any other.
- **Navigation.** One `hashchange` listener closes every open group. It is installed when the module loads, before `ui.mjs` installs its own, so the page rebuilt for the new address finds the groups closed. Following an event's link in the list therefore closes the list and opens the flow.
- **Return focus.** Closing that flow's detail returns focus to the group's summary: `ui.mjs` focuses the summary of a closed `<details>` that holds the opener. `findControl` now prefers the opener's own focus key over its address, because an event in the list and the flow's bar share an address. The list's links and the summary have focus keys.
- **Refresh.** An automatic refresh keeps an open list open and focus where it was, as other expanded sections already do.

**Tests.** "H5: Escape closes …" opens a group with focus on a list link, presses Escape, and checks that the list is closed, focus is on the summary, and the event was stopped. Escape on a closed group and Enter are left alone. "H5: a click outside …" checks that a click on the list keeps it open, a click elsewhere closes it, opening a second group closes the first, and navigation closes all. The listeners are captured as the module installs them. Real focus and keyboard behaviour in a browser are checklist items (A-03).

## H7: a hold named the slot-holding flow by its bare ID

**Problem.** A queued task's "Admission held" read "flow capacity exhausted; parked flows beyond policy.maxParkedFlows (3) hold slots: <flow id> (answer their questions)", with no link. Admission readiness already linked the same flow. The queue entry's observation joined plain strings: `holdText`, or the recorded reason when no current hold matched it.

**Fix.**
- `console/ui/admission.mjs`:
  - `withFlowLinks(project, text, ids)` shows every flow ID the project reported as a link through the existing `detailHref` and `flowTitle` helpers. It covers the snapshot's flows, the queue status's parked, waiting and category-wait flows, and any IDs in the hold's own fields. Only whole IDs are linked, and the rest stays text.
  - `holdNode`'s default case (holds without a structured code, such as the category reason) uses it after the local-time rendering.
  - `reasonNodes(project, task, reasons)` renders recorded reasons. A reason that exactly matches a current structured hold renders as that hold. Any other reason is linked and its times are made local.
- `console/ui/plan.mjs`:
  - The queue entry's "Admission held" and "Current advisory holds" are page content, not strings.
  - `startHints(snapshot, task, project)` gives each hold as content with links, so the reasons under a disabled "Start now" link the flow too.
- `console/ui/actions.mjs` renders each reason as a child node rather than through `text`. Strings still become text nodes, so nothing is parsed as HTML.
- `console/ui/queue.mjs` links flows in:
  - the "Last dispatch … found nothing to start" reasons;
  - the queue-held banner;
  - the Flow slots card's waiting reasons and category waits.

The admission reason strings and their structured fields are unchanged. No reason text is edited here (H10 is changing those separately); the console only links what it is given.

**Tests.** "H7: a hold given as text …" links a category hold's flow by title and leaves no bare ID; a partial ID match is not linked. "H7: Queue names the flow …" covers four places. The queue entry's observation links the matched capacity hold and an older recorded reason. "Current advisory holds" links before the first observation. The last dispatch's reasons link the flow. The Start-now reasons carry a link.

## H4: browser Back from an attempt, and the checklist

**Decision.** Choosing an attempt is a selection inside the flow's window, not a page of its own. It replaces the address (`?flow=…&attempt=…`) instead of adding a history entry. So one Back closes the window from the flow or after choosing any number of attempts, as B-07 and D-04 already said. The alternative, one entry per level as observed on dev.83, would make Back step through every attempt chosen before the window closed. A link that opens a flow with an attempt already chosen (Overview's "Inspect attempt", a shared link) is one entry, and one Back leaves it.

**Fix.** `ui/timeline.mjs`: the attempt bar calls `patchRoute({ attempt }, { replace: true })`. B-07 now states the behaviour and how to check it, and D-04 says one Back.

**Test.** "H4: choosing an attempt replaces the address …" clicks an attempt bar and checks that `history.replaceState` got the flow-and-attempt address and that no hash was pushed.

## H6 and the checklist review

`docs/qualification/console-browser.md` was read step by step against the current console. Every quoted heading, label and control in it was checked against the console's source. All are present, including the sixteen History kinds and the seven Settings sections. Changes:
- **A-03 (H6).** The measurement names what is rendered. On the Timeline tab, a single event is `.tl-ev` and a group is `details.marker-group.tl-ev-cluster`. In the execution timeline, a single event is `.marker` and a group is `details.marker-group.marker-cluster`. Groups are measured closed, and the counts are recorded. A phone window that is one group with no `.tl-ev` passes. `.tl-ev` is still rendered for single events, which is why it was missing only at phone width. The step now checks Escape (and the modal case), outside click, following a link and return focus, one group open at a time, and that refresh keeps it open.
- **A-05 (H7).** Every place a hold is shown must link the flows it names, with no bare ID. It also adds the Flow slots card, compared with `.queueStatus.capacity`; it was qualified on dev.83 but missing from the checklist.
- **A-10 (G15 f, carried from dev.82).** Text that offers a control needs the control. Text that says when one will appear ("Run doctor appears above once a configuration change needs it") is correct without it.
- **B-01 and the new B-08 (H3).** Flow summary has a "Flow slot" line, with each of the six states, compared with `status`. B-08 also runs at phone width.
- **B-07 and D-04 (H4).** As above.

## Compatibility

- **Records.** Unchanged. No reason text changed.
- **Service.**
  - The flow read gains `capacity`. Its computation reads the live flow set exactly as queue status already does on every snapshot.
  - No SQL JSON reads over `records.data` and no full scans were added.
- **Console.**
  - The console forwards `capacity` on flow reads.
  - Command reasons may be page content (built with `h()`); strings render as before.
  - No new static module.
- **Merging with H10.**
  - The console changes link whatever reason text arrives and do not depend on its wording.
  - `holdNode`'s `capacity` case is untouched.
  - If H10 adds an ID-bearing field to the capacity fact, any field named `flowId`, `flowIds` or `…FlowIds` is linked by the default case.
  - Expect a textual merge only if H10 edits the same lines in `ui/admission.mjs` or the A-05 checklist paragraph.

## Fail-before evidence

The base tree (`be3f9d0`) was extracted with `git archive` into a scratch directory. `tests/console-dev84.test.mjs` and `tests/fake-dom.mjs` were copied in and run there with `node tests/run.mjs tests/console-dev84.test.mjs`. Result: 8 tests, 0 passed, 8 failed, each on behaviour:
- `flowSlot` is missing.
- The flow read has no `capacity`.
- The summary has no Flow slot line.
- Escape leaves the list open.
- No outside-click or navigation listener is installed.
- Choosing an attempt pushes a history entry.
- A text hold's flow is not linked.
- Queue's observation does not link the flow.

## Verification

- `npm test`: 1197 tests, 1197 passed, 0 failed, 0 skipped.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.

No real browser was driven for this change. Focus movement, the capture-phase click, the dialog's handling of a prevented Escape, and the open list's position are checked by the browser checklist (A-03, B-07, B-08, D-04), not by these tests.

## Review fixes

An independent review (GPT-6.1 Sol) of `f681cf4` approved it with fixes. It confirmed four things:
- the six slot states, parking beyond the cap, merge priority and position;
- indexed reads with no SQL JSON and no private fields;
- safe links;
- H4's history replacement, which stays.

One finding blocked.

### 1. Blocking: flow detail and Queue disagreed about a category-only wait

**Problem.** `flowSlot` called a waiting flow `category` when its category was full and its pool had a slot nobody held. `categoryWaits`, which Queue shows, also subtracts the slots already reserved for other waiting flows. Repro: `maxFlows: 2`, `categoryLimits: {docs: 1}`, one docs flow working, an answered docs flow waiting, and an answered flow of another category that the free slot is reserved for. Queue showed no free slot and no category wait, while the docs flow's detail said `category`.

**Fix.** `operations/capacity.mjs`: `waitsOnCategoryOnly(state, flow)` is now the one test. It matches a waiting flow the allocation passed over, whose category is full, while its pool has a slot that no waiting flow has been granted. `categoryWaits` lists the flows it accepts, and `flowSlot` reports `category` for exactly those flows. In the repro the docs flow's detail now reads `waiting`, as Queue implies.

**Test.** "H3: flow detail and Queue agree on a category-only wait …" builds the repro. It checks that Queue has no free slot and no category wait, and that the docs flow is `waiting`. With `maxFlows: 3` (a slot to spare) both say `category` again. For every waiting flow in both cases, the detail says `category` exactly when Queue lists it. The earlier surplus case also checks Queue's list now. The test fails on `f681cf4` ("its detail says it waits for a slot, as Queue does").

### 2. Low: "Flow Flow · …"

**Problem.** The category-wait text begins "Flow <id> was answered". Once the ID became a link titled "Flow · <title> #tag" (or "<workflow kind> · …"), it read "Flow Flow · Fictional build #flow-c was answered …".

**Fix.** `console/ui/admission.mjs`, `withFlowLinks`: a "Flow " at the start of a sentence, directly before a linked flow ID, is dropped, because the link's title already names the flow. This is presentation only. The canonical reason text in `operations/capacity.mjs` is unchanged, and other wording before an ID ("stopped flow, <id>", "held by <id>") is untouched.

**Test.** `console-flow-slots` expects "… its category. Flow · Fictional build #flow-c was answered …" and rejects "Flow Flow". The H3 summary test rejects it in every slot state. On `f681cf4` the `console-flow-slots` assertion fails.

### Merge with main

`main` at `2cbfb83` (the dev.83 re-test verdict, one line in `docs/one-factory-progress.md`) merged without conflicts.

### Verification after the review fixes

On the merged tree (review fixes plus `main`):
- `npm test`: 1198 tests, 1198 passed, 0 failed, 0 skipped. The one added test makes the difference from 1197.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.
