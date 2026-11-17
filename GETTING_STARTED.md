# Getting started: an adoption brief for your project agent

Point your project's agent or orchestrator at this file and identify the target project checkout. For example:

> Follow `/absolute/path/to/factotum/GETTING_STARTED.md` to set up Factotum in the current project and prepare a first real development pilot.

The instructions below are the reusable handoff. Keep the reference checkout read-only; installation and project-specific changes belong in the adopting project.

## Understand the project and reference

Read the project's applicable instructions, inspect its working tree and repository setup, and identify its actual setup, baseline and acceptance commands. Preserve existing work and follow its normal change process.

Read these reference guides:

- [README](README.md): purpose, supported environment and boundaries.
- [Running](docs/running.md): requirements, commands and commissioning.
- [Updates](docs/updates.md): locked installation, isolated update branches and runtime activation.
- [Adoption](docs/adoption.md) and [project customization](starter/project/README.md): required contracts and replacement points.
- [GitHub](docs/integrations/github.md) and [providers](docs/integrations/providers.md): credentials, model roles and delivery behavior.
- [Shared console](docs/web-console.md): registering independent projects in one interface.
- [Qualification](docs/qualification.md): exercised behavior and evidence limits.

For an existing factory migration, also follow the [migration guide](docs/migration.md). Use a drained cutover and drained upgrades, retaining original executors and evidence for recovery.

## Install and configure

Before configuring, go through `starter/project/SETUP_CHECKLIST.md` with the operator: who decides merges and deploys, how work flows, what happens with direct commits to main, offline data, previews and doctor. Ask about each choice rather than assuming a default.

Use the [locked installation workflow](docs/updates.md#initial-adoption) to prepare a verified starter and `factotum.lock.json` on a separate review branch/worktree. Obtain a trusted release artifact and digest, or explicitly build a development artifact as documented there. If the project root already has its own `VERSION`, `compatibility.json`, `factory/` or `project/`, install under a folder with `--prefix` (for example `tools/factotum`); then every `factory/` and `project/` path below is under that folder, and the CLI is `node tools/factotum/factory/cli.mjs`. See [install under a folder](docs/updates.md#install-under-a-folder). Keep `factory/` upstream-owned; put project extensions outside it. Configure the project-owned files in the review worktree:

- Reproducible workspace setup and real baseline/candidate checks. Replace every deliberately failing template command; a placeholder success is not verification.
- Required governing context from the project's actual instructions.
- The actual GitHub repository, target branch and explicitly selected account.
- Repository-local Git identity: set `git config --local user.name 'Your Name'` and `git config --local user.email 'you@example.com'`; factory Git ignores global identity, and doctor requires both.
- Approved subscription-backed builder and independent reviewer routes, plus planning and risk policies appropriate to the project.
- Fresh private project state outside all repository checkouts. Keep credentials, private configuration, absolute runtime paths and provider artifacts outside tracked files. The project's configuration file lives outside the checkout too, in a private directory ([where it lives](docs/adoption.md#copy-and-configure)).

Follow the installed `factory/AGENTS.md` ownership policy. Keep it as required agent context alongside the project's governance, and carry the same rule into the project's root agent instructions. All project-specific Factotum changes belong in configuration or integrations such as `project/integrations/`; supplied adapters inside `factory/` remain upstream-owned. Report missing core capabilities upstream through the operator, then adopt a reviewed release instead of making a local core patch. Update generated version/lock records only through the adoption tools.

An optional [project agent skill](starter/project/skills/use-factotum/SKILL.md) is included at `project/skills/use-factotum/` after installation. Copy that folder into the project's existing agent skills directory and adapt its local conventions. It covers adoption, integrations, delivery, recovery and updates while preserving the core ownership boundary. It remains project-owned and does not automatically route unrelated application work through Factotum. The companion `project/skills/factotum-workflows/` skill covers project-owned workflows, per-step models and delegated merge decisions; install it the same way.

Start with one active change, reviewed planning, manual merge and spending disabled. Release/evaluation adapters and scheduled automation are optional later additions. Use the delivery-required systemd containment described in the running guide.

Publish the installation through the project's existing change process before commissioning. `doctor` requires a stopped runner and a clean target checkout synchronized with its remote; the first factory task cannot bootstrap an installation that is not commissioned yet.

One console serves every project on the machine. Check for it first (`systemctl --user status factotum-console.service`; its state is usually beside the other projects' state, for example `~/.local/state/factotum/console/`). If it exists, register this project's service with it; never start a second console. Install the console only when none exists yet. Each project retains its own identity, state and authority. If projects share heavy host work, configure one common resource coordinator and ensure their heavy commands use it.

## Commission and report readiness

Initialize a new project identity with the private configuration, run `doctor`, and resolve its actual findings. Start the project service and register it with the console using the documented CLI commands. Verify that the console shows the intended project and its commissioning state.

Report readiness before launching the first pilot task. Include the installed version, check commands and baseline results, selected provider roles, commissioning result, console URL and any unresolved adoption issues. Keep sensitive installation details in the project's private records.

A passing doctor establishes readiness for the pilot; it does not establish successful delivery or qualify automatic merge.

## Run one real pilot

Use the operator's selected task. If none was supplied, propose one small, useful task with concrete acceptance criteria before launching it. Exercise the complete path:

1. Import or create the task, then obtain separate canonical approval of its exact revision.
2. Run reviewed planning and implementation in an owned worktree.
3. Complete fresh independent review, any corrections and the project's real candidate checks.
4. Present the exact reviewed candidate for the operator's merge decision.
5. Verify remote merge, configured source-task disposition, owned cleanup and retained evidence.

Use the canonical CLI or web commands for decisions and recovery. Preserve uncertain attempts and reconcile their original evidence rather than replaying external writes. Do not enable paid adapters, deployment or automatic merge as a side effect of this pilot.

## Report the adoption result

Distinguish setup readiness from the completed pilot. Record what passed, what failed, recovery exercised and anything still unqualified. Identify missing documentation, adoption friction and generic assumptions that should be improved upstream. Use the copyable [upstream feedback template](starter/project/UPSTREAM_FEEDBACK.template.md) to prepare a concrete, sanitized report.

Keep project-specific configuration and evidence in the adopting project's appropriate tracked or private locations. Report generic reference improvements separately; do not edit the reference checkout or put real project identities, credentials or transcripts in its fictional fixtures.
