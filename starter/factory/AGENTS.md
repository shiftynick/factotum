# Factotum core ownership

These instructions govern vendored Factotum copies in adopting projects. Development of Factotum itself belongs in its upstream reference checkout through the normal upstream change process.

## In an adopting project

- Treat every file under `factory/` as upstream-owned (when the installation sits under a folder, such as `tools/factotum/`, that is `tools/factotum/factory/`; `factotum.lock.json` at the repository root records the folder as `prefix`), including the supplied adapters, console, CLI and this instruction file. Do not edit, delete, reformat, monkey-patch or generate replacements for these files during project work.
- Put project-specific Factotum behavior in project-owned configuration, checks, governance and integrations outside `factory/`. Prefer `project/integrations/` for custom adapter scripts, with documented configuration/argv extension points connecting them to Factotum.
- Preserve the upstream ownership rule in the project's governing instructions. Keep this file as required governing context for factory agents alongside the project's actual rules.
- If an integration needs a missing core capability or exposes a core bug, report the limitation and a proposed upstream change to the operator. Do not work around it by patching the vendored core. An upstream contribution is separate work in the reference checkout; the consuming project then adopts the reviewed release.
- Change upstream files only through the verified release adoption/update workflow. `VERSION`, `compatibility.json` and `factotum.lock.json` are generated release/adoption records; do not hand-edit them to conceal drift or make an update appear valid.
- Prepare updates on a separate review branch/worktree, preserve project-owned integrations, and follow the drained runtime activation and commissioning process. Do not replace code beneath active work.

This ownership rule applies to Factotum customizations. Normal application development continues in the project's application files. The lockfile/updater detects core drift; these instructions do not constitute filesystem isolation.
