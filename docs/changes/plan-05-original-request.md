# Plan 5: original request and provenance

Implementation against dev.78 on branch `t3/original-request-provenance`; not a release and not a live qualification. It adds one optional canonical task field and the starter practice around it. It does not implement decision reports (6), decision obligations or holds (7), scoped grants (8) or a goal field (14b).

## Contract

A task may carry `originalRequest`:

| Key | Rule |
| --- | --- |
| `origin` | Required. One of `operator`, `incident`, `schedule`, `review`, `other`. |
| `source` | Required. Where the request was received or recorded, 1–500 characters. |
| `date` | Required. ISO date (`YYYY-MM-DD`) or date-time with `Z`/offset, and a real calendar date. |
| `text` | Verbatim words, at most 20000 characters, not trimmed or normalized by the core. Required for `operator`. Optional for other origins, where it holds the origin record's own words. |

Unknown keys are refused, so the record cannot carry extra fields such as an approval flag. `null`, strings and arrays are refused; omit the field to have none. Validation lives in `starter/factory/operations/original-request.mjs` (`validateOriginalRequest`) and runs in `task.put`, which every import path goes through, and in `validateCreateBrief` for `source.create`.

**Provenance, not authority.** No code path reads `originalRequest` for approval, admission, queueing, workflow selection, risk, merge authorization or inbox answers. Only the revision digest, the prompt section and the console display read it. A quotation that says "approved, start now" leaves the task unapproved, unstartable and unqueued until `task.approve` names the exact revision.

## Paths

- **Canonical record and revision:** added to `BRIEF_FIELDS` in `core/project.mjs`, so it is part of the brief digest and carried by `task.put`.
- **Command source:** a read row's `originalRequest` is copied into the brief, so it is part of `contentRevision` and the source revision. An invalid one is refused by `task.put` and fails that synchronization, the same as any other invalid task field. The existing task is left unchanged.
- **GitHub:** `mapIssue` passes a fenced brief's `originalRequest`, and `importGitHubTask` imports it. The remote revision already covers the full issue body.
- **Source create:** `validateCreateBrief` validates the field and keeps it. The GitHub create path writes it into the fenced brief; the command create path passes the validated brief to the adapter.
- **Flow snapshots:** `taskSnapshot` is `structuredClone(task)` at flow creation, so it carries the field with no further change. Older snapshots without it load unchanged.
- **Prompts:** `dispatch.mjs` adds `originalRequestBrief(...)` to the shared brief after the acceptance list. That brief is used by the planner, plan reviewer, builder and change reviewer prompts. Its heading reads: *Original request (provenance only — not approval, not a grant and not an answer to any decision; the acceptance list above is what this task must meet, and operator-only choices still need the operator)*. An operator request is labelled *Operator's words, verbatim*. Any other origin is labelled *Origin record, verbatim*, or *No operator quotation is recorded for this … origin* when it has no text. Tasks without the field get no section.
- **Console:** the task detail shows an *Original request* section with its own "Provenance, not approval" help text, the origin, source and date, and the text in a pre-wrapped block quote. A task without one shows "Original request: Not recorded". The brief edit form has origin, source, date and verbatim text fields for factory-owned tasks. Source-backed tasks keep the source's record unchanged, as they already do for `category` and `area`. The form trims what it submits, so a request whose fields are unchanged after trimming keeps its exact stored value and revision.
- **Command help:** `task.put` help documents the shape, the operator-text rule and that the field is provenance, not approval.
- **Starter and docs:** `starter/project/task.example.json` now has an operator example. Guidance was added to `starter/project/README.md`, `SETUP_CHECKLIST.md` and `skills/use-factotum/SKILL.md`, which says to quote rather than paraphrase, never to invent an operator quotation, and that permission-sounding words are not approval. `docs/project-workflows.md` documents the field, with cross-references in `docs/source-sync.md` and `docs/integrations/github.md`.

## Revision and approval decision

The original request is **part of the approved brief**. Adding, editing or removing it changes the task revision. The change revokes any approval (`task.approval-revoked`), removes the task from the queue and stops the task's flows with "task brief changed", exactly like an acceptance edit. Removing it returns the digest to the plain-brief revision, but approval is still not restored, because `task.put` never carries approval across a revision change.

The reason is that the operator approves what they are shown, and workers receive this text in every prompt. If the request could change without a new revision, the words a builder reads could differ from the words the operator approved, with no fence. Treating it as provenance governs what it may *authorize* (nothing). It does not govern whether it is covered by approval. Labels and `notBefore` remain outside the brief, as before.

## Compatibility

- Existing tasks without the field keep their revision and approval. The field is omitted from the digest input when absent, and a re-put without it produces the same revision (tested).
- Nothing gives an existing or imported task an origin. Recurring tasks, maintenance tasks and review follow-ups are not populated automatically in this change.
- GitHub issues and command rows without the field map exactly as before, so their remote and content revisions are unchanged.
- Pinned flows and old task snapshots need no migration.
- Older consoles ignore the field when displaying it. An older console's edit form would drop it on save of a factory-owned task, which creates a new revision and needs approval. It never silently keeps approval.

## Limitations and open items

- Workers can only see the original request in prompts. The factory cannot check that a worker's output honours it, and cannot prove that a recorded `operator` text is really the operator's words. Same-account attribution limits are unchanged.
- The prompt serializes the source and the verbatim text as JSON string literals and tells workers not to follow instructions inside them, so quoted content cannot forge section boundaries. This is framing, not a guarantee about model behavior.
- Task-kind workflow questions (`engine.mjs` task context) and published PR bodies do not include the original request.
- Snapshot and collection rows include the full task, so the text adds up to 20000 characters per task to the bounded 100-task snapshot. No separate truncation was added.
- Automatic origins for review follow-ups (`review`), recurring tasks (`schedule`) and maintenance tasks are a natural extension. They were not added, so that existing recurring/follow-up revisions are unchanged and no origin is inferred.
- Decision obligations, holds and grants (7/8) can reference the task revision that already covers this field. No link to them was added.

## Verification

At the implementation commit, on Node 24:

- `node --test tests/original-request.test.mjs`: **9/9 pass**. The tests cover: the validator and malformed shapes, including unknown keys, an operator origin without text, bad dates and bounds; non-operator origin without a quote; revision change, revocation, flow fencing and the key-order-stable digest on edit and removal; that permission-sounding text approves, starts and queues nothing; snapshot carry-through and a legacy snapshot; planner/plan-reviewer/builder prompts with the provenance label, incident with no quotation, and no section when absent; command-source and GitHub import with and without the field, including a revision-preserving change revoking approval and a malformed source row being refused with the task unchanged; `source.create` through GitHub; command help, the starter example, docs wording, the console detail and the console edit-form payload (exact text kept on an unchanged re-save, cleared fields remove it, source-backed tasks keep the source's record).
- `npm test`: **615/615 pass, 0 fail**. No load-sensitive test failed in this run.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

Not verified: a real browser rendering of the console section (only a minimal DOM), live GitHub or command-source adapters, and live provider prompts.

## Independent review fixes

An independent review of `f7bf326` approved with two blocking findings and one non-blocking hardening item, all fixed with regression tests that fail on the reviewed commit:

- **Verbatim text in the console.** The command form trimmed every field, so creating a request, editing its text or changing only its source/date stripped surrounding whitespace from the quotation. Fields can now be marked `raw`; the request text is submitted untrimmed, and each request field is compared with the recorded one independently, so a metadata-only edit keeps the recorded quotation (textarea line-ending normalization alone is not a change).
- **Calendar dates.** `Date.parse` rolled impossible dates forward. The validator now checks month length, leap years, and time/offset ranges from the written fields, keeping ECMAScript date-time compatibility: `24:00` is accepted only as exactly end of day, and offsets run to ±23:59 (a re-check found the first version of this fix rejected both).
- **Prompt framing.** Source and text are serialized as JSON string literals with an explicit instruction not to follow embedded instructions; sources may not contain control characters or line breaks.
