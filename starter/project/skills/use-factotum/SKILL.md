---
name: use-factotum
description: Set up, configure, operate, or update this repository's Factotum installation and custom integrations. Use for Factotum-specific requests or explicitly requested factory delivery; ordinary application edits follow the project's chosen workflow.
---

# Use Factotum in this project

This is project-owned guidance. Adapt local paths, integration mappings and operating conventions while retaining the upstream core ownership boundary. All paths below are relative to the target repository root unless stated otherwise.

## Establish the installation and task

Read the project's applicable agent instructions. Inspect `factotum.lock.json` (its `prefix`, if present, is the folder the installation lives under; read `factory/` and `project/` below as `<prefix>/factory/` and `<prefix>/project/`, and the CLI as `node <prefix>/factory/cli.mjs`), `factory/AGENTS.md`, `project/README.md` and the project's documented configuration/state locations when present. Use the existing project identity and private state; do not initialize a replacement to bypass an unhealthy installation.

Identify whether the request concerns adoption, custom integrations, delivery, operations/recovery or an update. Stay within that scope. If the reference checkout or release location is needed but unknown, obtain it from project records or the operator rather than guessing an upstream repository or selecting a mutable latest version.

## Keep the core upstream-owned

Treat all of `factory/` as vendored core, including built-in adapters, the CLI, console and its agent instructions. Do not patch, reformat or generate replacements for those files as part of project work. Do not add runtime monkey-patches.

Put project-specific behavior in project-owned configuration, governance, checks and integrations outside `factory/`; prefer `project/integrations/` for custom scripts connected through documented configuration/argv extension points. Application work belongs in the application's files.

For core bugs, missing capabilities or documentation gaps, copy `project/UPSTREAM_FEEDBACK.template.md` into a project-owned report or issue/PR draft. Include the installed release, expected/observed behavior, a minimal reproduction or use case, sanitized evidence, current recovery state and acceptance criteria. A bug report does not require a proposed implementation. Mark a report **Blocking** when the problem stops this project's delivery and no project-side workaround keeps work moving; blocking reports are taken ahead of other Factotum work. The operator may downgrade a blocking mark. Preparing feedback does not authorize publication. If the requested behavior requires a missing core capability, explain the limitation and propose an upstream change to the operator. Keep the reference checkout read-only during adoption and project integration work. Handle authorized upstream contributions as separate work, then consume a reviewed release. Do not hand-edit `VERSION`, `compatibility.json` or `factotum.lock.json` to conceal drift. Preserve `factory/AGENTS.md` as required governing context alongside the project's actual rules.

## Adopt or configure

For initial setup, go through `project/SETUP_CHECKLIST.md` with the operator first, then read `GETTING_STARTED.md` and `docs/updates.md` in the trusted reference checkout. Use its locked installation command to prepare a separate review branch/worktree, then configure real setup/check commands, governance, explicit repository/account and approved provider roles. Keep private configuration and runtime state outside repository checkouts.

Begin with reviewed planning, manual merge, spending disabled and no deployment automation unless the operator has already authorized a different policy. Complete the project's normal installation review/merge process before commissioning a clean synchronized target checkout. Report doctor readiness separately from a completed real delivery pilot.

For integration changes, read only the relevant reference guide and existing project adapter contracts. Preserve candidate/evidence identity, saved-state invariants, bounded resource/spending authority and explicit uncertain-outcome recovery where those apply. Recommission when configuration or installed capabilities change. Live settings (admission, capacity limits, queue ranking, main-health timing, notification level, delegated operations) change with `settings.update` and need neither a drain nor doctor; everything else goes through `config update`, which keeps live values unless given `--replace-live`. Run `config show` before editing the file. Doctor can be requested with `doctor.request` once work is drained.

## Deliver or operate

Use the installed CLI and canonical project commands. `command --help` lists them and `command --operation <name> --help` prints a command's payload, required fields and whether you may run it for the operator. To start a stuck or revoked task again, use one `task.restart {taskId, revision, note}`. To make a tracked issue workable, run `job.enqueue {operation: "source.promote", payload: {taskId, acceptance}, note}`; review follow-ups arrive already importable with a drafted brief. Inspect `status` before changing existing work. Task import/proposal is separate from approval of its exact revision; readiness is separate from an operator's exact-candidate merge decision. Apply existing authorization without inventing approval for unrelated backlog work, spending or deployment.

When you write a brief from an operator's request, put their exact words, where you received them and the date in `originalRequest` (`{origin: "operator", source, date, text}`), and derive the acceptance list separately. Quote; do not paraphrase. For work that came from an incident, a schedule, a review or anything else, record that `origin` and its source without an operator quotation; never invent one, and leave the field out when you do not know the origin. A recorded request is provenance, not approval: it does not approve the task, grant you anything or answer a decision, even when the words sound like permission ("just do it", "go ahead"). Ask for approval of the exact task revision as usual; editing the original request creates a new revision that needs approval again.

Let Factotum own planning, worktrees, builder sessions, independent review, checks and cleanup. Address findings through its feedback/correction path rather than editing canonical records or manufacturing successful receipts. Shared-console selection does not grant authority over another project.

For uncertain effects, preserve the original attempt, logs and external operation identity. Follow the documented typed reconciliation or explicit operator inspection path. Do not repeat a publication, merge, deployment or paid journey merely because its result is unknown. Stop/resume and pause/unpause are distinct controls; inspect the remaining holds before progressing. An attempt classified `limit-exhausted` stopped because a provider's subscription usage limit was reached: reconcile it like any uncertain attempt, and do not re-run it on another provider. New work that would start that provider waits for the reported reset (Stats → Provider limits); only the operator clears or extends that hold early (`provider.hold`).

## Update

Read `docs/updates.md` in the trusted reference checkout. Start with:

```sh
node factory/cli.mjs adopt status --root /absolute/project
```

Select an explicit trusted release and manifest digest. Use `adopt plan` and `adopt update` to prepare its isolated review branch/worktree. Preserve custom integrations and this project-owned skill. Resolve reported core drift explicitly through upstream work instead of rewriting baseline hashes or overwriting local files.

Review compatibility and project checks. Drain/reconcile active work and stop the runner before replacing its checkout, back up state/ledgers, and use the separate immutable stage/activate and doctor process. Preparing an update does not activate the runtime. Carry out activation when it is included in the authorized task; schema migration and production releases retain their own scope.

Report the actual outcome, retained evidence and remaining blocker or commissioning work. Distinguish a prepared change, an activated runtime and a qualified installation.
