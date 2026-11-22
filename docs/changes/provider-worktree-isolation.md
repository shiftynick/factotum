# Provider worktree isolation

Fixes the runtime follow-up [Codex project configuration and skills in a governance-edit worktree](../runtime-followups.md#codex-project-configuration-and-skills-in-a-governance-edit-worktree). Base: `main` at `cc6807c`. Required before knowledge upkeep slice 6 relies on the governance-edit suppression ([governance-edit context](governance-edit-context.md)).

This is a local implementation record, not a release or live qualification claim.

## The gap

[Governance-edit context](governance-edit-context.md) started Codex with `-c project_doc_max_bytes=0` for a step of an approved governance-edit task, so Codex read no `AGENTS.md` from the worktree. A worktree can also carry Codex's own project folders (`.codex/`, `.agents/`) and Claude Code's (`.claude/`, `.mcp.json`). A builder can add or change them in the candidate, and a later model step in the same worktree may load them. That project-document setting did not cover them.

Checked on the build host (Codex 0.169.0, Claude Code 2.1.325) without any model session (see [How the flags were confirmed](#how-the-flags-were-confirmed)). With the flags every task ran with before this change:

| Surface | Before this change |
| --- | --- |
| Codex skills in `.agents/skills/` and `.codex/skills/` (nested, and linked folders), from the working directory to the repository root | **Loaded, for every task.** Each skill's name and description were in the model's context, and a `$name` mention in the prompt loaded the skill's full `SKILL.md`. The prompt can quote candidate text |
| Codex `AGENTS.md` | Loaded for every task except an approved governance edit |
| Codex `.codex/config.toml` (for example `developer_instructions`), project hooks, rules, agents and MCP servers | Not loaded. Codex loads the project `.codex/` layer only for a trusted project, and `--ignore-user-config` drops the trust record in `$CODEX_HOME/config.toml`, so the worktree counted as untrusted. Without `--ignore-user-config`, a factory worktree of a trusted checkout inherits the trust and the layer loads |
| Claude Code `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, skills, commands, agents, settings hooks and `env`, `.mcp.json` | Not loaded. `--safe-mode`, `--setting-sources ''`, `--restricted` and an empty `--strict-mcp-config` were already on every invocation. Built-in skills and commands stayed available |

So the open route was Codex skills, for every task. Codex's project configuration was off, but only as a side effect of `--ignore-user-config`.

## The decision: every model step, every task

Every provider invocation, for every task, fresh and resumed, runs with the isolation below. The governance-edit request (`suppressWorktreeInstructions`) still exists; it now asks for what every step already gets. The factory delivers governing context itself (`context.files`); nothing reaches a model by a side route the operator cannot see in the package.

This is safe because:

- the factory never relied on these folders;
- Claude Code steps already ran this way;
- each flag is a documented CLI option or configuration key, checked against the installed CLIs;
- the adapter refuses to start a provider whose arguments lack the isolation.

The cost: a project whose Codex steps depended on a root `AGENTS.md` that is not in `context.files`, or on repository skills, loses that (see the release notes).

### The flags

`adapters/providers/index.mjs`, `WORKTREE_ISOLATION` and `codexWorktreeIsolation`. This is the mechanism after the [review of `6bd5cf9`](#review-of-6bd5cf9); the first version scanned the worktree's skill folders instead, which the review showed cannot isolate them.

**Codex runs from an empty working root.** Codex 0.169.0 has no option that turns repository skill discovery off; see [How the flags were confirmed](#how-the-flags-were-confirmed). It discovers repository skills (`.agents/skills/`, `.codex/skills/`), `AGENTS.md` files and the project `.codex/` layer only in its working directory and in the folders above it up to the project root.

- **The working root.** For every Codex step the adapter creates `codex-root-<random>`, a fresh, empty, private (0700) folder in the step's artifact folder, and starts Codex there. The artifact folder is in the state directory, which is outside every project checkout.
  - With `project_root_markers=[]`, Codex searches no folder above the working root.
  - The working root and the worktree must not contain each other; otherwise the step is refused.
  - So Codex discovers nothing in the worktree, whenever it was written. A skill added after the invocation was built, or behind a link retargeted later, is not discovered.
  - A mention resolves only to a discovered skill: `$name`, or a link to the skill's `SKILL.md` by path. So no mention can load anything from the worktree.
- **The model still works in the worktree.**
  - It is the step's only writable root besides the working root and `/tmp` (`sandbox_workspace_write.writable_roots`, a configuration key, so it applies to `exec resume` as well).
  - Codex lists it to the model as a workspace root.
  - The prompt starts with `Repository: <worktree>` and a sentence telling the model to run every command there and use paths under it.
- **What the factory still sees unchanged.** The factory's recorded prompt, the brief, the reviewed plan and the checks are unchanged. Only Codex's process runs elsewhere.

| Provider | Flag | What it turns off |
| --- | --- | --- |
| Codex | working directory: `<artifact folder>/codex-root-<random>` (new) | Every discovery from the worktree: repository skills, `AGENTS.md`, the project `.codex/` layer |
| Codex | `--ignore-user-config --ignore-rules` (unchanged) | `$CODEX_HOME/config.toml` (and with it every project trust record), and user and project execpolicy `.rules` |
| Codex | `--disable hooks` | `features.hooks`: "Enable lifecycle hooks loaded from `hooks.json` or inline `[hooks]` config". No hook loads from any layer |
| Codex | `--disable plugins` (dev.106) | `features.plugins` off: no plugin, configured or remote-installed, is loaded, so no plugin skill root. See [dev.106](dev106-codex-skill-discovery.md#review-fixes) |
| Codex | `--skip-git-repo-check` (new) | Codex's refusal to run outside a Git repository: the working root is not one |
| Codex | `-c project_doc_max_bytes=0` | No `AGENTS.override.md`, `AGENTS.md` or fallback project document |
| Codex | `-c skills.include_instructions=false` | "Include the automatic skills instructions in the model context": off, so no skills catalog |
| Codex | `-c skills.bundled.enabled=false` (new) | "Load the system skills bundled with Codex": off |
| Codex | `-c project_root_markers=[]` (was `[".git"]`) | "Set `project_root_markers = []` to skip searching parent directories" |
| Codex | `-c sandbox_workspace_write.writable_roots=["<worktree>"]` (new) | Nothing; it is where the model works |
| Codex | `-c projects={"<dir>"={trust_level="untrusted"}, ...}` | The working root, the worktree and every folder above either, explicitly untrusted. "Codex ignores project `.codex/` layers, including `.codex/config.toml`, project-local hooks, and project-local rules", whatever trust another layer records. `--trust` "does not override an explicitly untrusted project" |
| Codex | `-c skills.config=[{path="<SKILL.md>",enabled=false}, ...]` (now the operator's skills, not the worktree's) | Each `SKILL.md` under `$CODEX_HOME/skills` (default `$HOME/.codex/skills`), `$HOME/.agents/skills` and `/etc/codex/skills`, found at invocation, by its path and its real path |
| Claude Code | `--safe-mode` (unchanged) | "Start with all customizations (CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, output styles, workflows, ...) disabled", the operator's own included |
| Claude Code | `--setting-sources ''`, `--restricted`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (unchanged) | No user, project or local settings files, and no MCP server but the empty list |
| Claude Code | `--disable-slash-commands` | "Disable all skills and commands", built-in ones included, so not even a `/name` prompt runs one |

**The operator's own skills** are disabled for factory steps too (decided after the review).
- **Claude Code:** `--safe-mode` already did this.
- **Codex:** bundled skills are off by configuration, and each skill in the operator's and administrator's folders is disabled by path.
- **Why a scan is acceptable here.** These folders belong to the operator, not to a candidate. A candidate's files never reach them; only a process writing outside its worktree could, and no provider option can stop such a process. A builder's or a check's own process can write there, for example a Claude Code builder's Bash.
- **No allowlist.** Factory prompts name no skill, and the catalog is off, so an allowed skill would load only if the prompt named it. Making an allowlist useful would mean turning the catalog back on, which lists every skill not disabled. An allowlist is therefore not offered.

**Failing closed.**

- **Preflight.** It requires `--disable` and `--skip-git-repo-check` (Codex) and `--disable-slash-commands` (Claude Code) in `--help`, as whole words.
- **Before the CLI starts.** The adapter refuses the invocation (`PROVIDER_REJECTED`, not started) in these cases:
  - **Working root.** The working root and the worktree contain one another; for example, an artifact folder inside the worktree.
  - **Working directory.** It cannot be resolved.
  - **Paths.** A path holds a control character or an unpaired surrogate, so it cannot be written as TOML. Quotes and backslashes are escaped.
  - **The operator's skill folders**, read within bounds:
    - one cannot be listed or resolved;
    - a folder holds more than 4096 entries (entries are read one at a time, so a huge folder is never read whole);
    - the scan goes deeper than 8 levels or reads more than 2000 folders;
    - there are more than 256 distinct skills, counted by real path, so a link to a skill is not a second one.
    - Since dev.106 these bounds apply only to a Codex version whose skill discovery has not been checked. For a checked version, the scan follows Codex's own discovery: depth 6, no hidden folders, and its 2,000-folder and 20,000-entry caps. See [dev.106](dev106-codex-skill-discovery.md).
- **Every invocation.** `assertWorktreeIsolation` checks the arguments and the working root before the CLI starts. Codex needs:
  - the static flags;
  - the writable root, the untrusted projects and the disabled skills;
  - a working root and worktree that do not contain one another.

  Claude Code needs `--safe-mode --setting-sources '' --disable-slash-commands`. Anything less is refused.

**Recovery when a bound is hit.**
- **What happens.** The refusal is raised before any model starts. The attempt settles as failed, with the refusal's message as its error. The flow takes the step's failure route: in the reference graphs it fails, and the failed-flow notice reads `Failed at <step> (attempt <id>): <message>`.
- **What the operator does.** Remove the cause in their own skill folders, as the message names it: the deep or crowded folder, the unreadable folder, or the extra skills. If the state directory sits inside a project checkout, move it out. Then run `task.restart` for the task, or put the task again.
- **What a candidate can't do.** A candidate cannot cause these refusals: nothing in its worktree is read by the scan.

**`CODEX_HOME` is not replaced.** The login lives there; copying `auth.json` elsewhere would fork the refresh token and can sign the operator out. `$CODEX_HOME/AGENTS.md`, the operator's global Codex instructions, is still loaded: no Codex 0.169.0 option turns it off (see [Open questions](#open-questions)).

### How the flags were confirmed

**No model session was started.** Every check below ran on the build host against Codex 0.169.0 and Claude Code 2.1.325.

**Help and documentation.**

- **Codex help.** `codex exec --help` and `codex exec resume --help` list:
  - `--disable <FEATURE>` ("Equivalent to `-c features.<name>=false`");
  - `-c, --config <key=value>`;
  - `--ignore-user-config` ("Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`");
  - `--ignore-rules`;
  - `--trust` ("Does not override an explicitly untrusted project");
  - `--skip-git-repo-check` ("Allow running Codex outside a Git repository").
- **Codex features.** `codex features list` lists `hooks` (stable, on).
- **Codex documentation.** The configuration reference and advanced configuration pages document:
  - `skills.include_instructions`, `skills.bundled.enabled`, and `skills.config.<index>.path` / `.name` / `.enabled` (no wildcard; "Absolute path to one `SKILL.md` file", "Match every skill with this exact name");
  - `sandbox_workspace_write.writable_roots`;
  - `features.hooks`, `project_root_markers` ("Set `project_root_markers = []` to skip searching parent directories") and `project_doc_max_bytes`;
  - untrusted projects ignoring the project `.codex/` layer;
  - project entries with `trust_level = "untrusted"`.
- **No switch for repository skills.** None of the following turns repository skill discovery or mention loading off; each was checked with the capture below:
  - the configuration reference, `codex features list` (every feature) and the configuration keys in the binary;
  - `--enable skip_host_skill_discovery`, `--enable mentions_v2`, `--disable skill_search` and `--enable omit_skill_descriptions`;
  - `skills.config` with `name="*"`, with a skill folder's path or with the repository root's path;
  - `project_root_markers=[]` with the worktree as the working directory.
- **Claude Code help.** `claude --help` documents `--safe-mode`, `--setting-sources`, `--restricted`, `--strict-mcp-config` and `--disable-slash-commands`, quoted above.

**Offline capture.** Both CLIs were pointed at a local HTTP endpoint that records the request body and answers HTTP 400:

- **Codex:** `-c model_providers.capture={base_url="http://127.0.0.1:<port>/v1",wire_api="responses",env_key=...}` in place of `model_provider="openai"`, with a scratch `CODEX_HOME`;
- **Claude Code:** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` with a dummy key and a scratch `HOME` and `CLAUDE_CONFIG_DIR`.

The request is what the model would have received; nothing left the host. The scratch repository planted a canary in every surface:

- `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/`;
- `.codex/config.toml` with `developer_instructions` and hooks;
- `.codex/hooks.json`, `.claude/settings.json` and `.claude/settings.local.json`, with hooks that write marker files;
- skills in `.codex/skills/`, `.agents/skills/` (nested and linked) and `.claude/skills/`;
- `.claude/commands/` and `.claude/agents/`;
- `.mcp.json` with a server that writes a marker.

Each prompt also named every skill (`$name`, `/name`).

| Run | Result |
| --- | --- |
| Codex, no flags, repository trusted in the scratch `config.toml` | `developer_instructions`, `AGENTS.md`, both repository skills in the catalog, and the skill bodies on `$name` |
| Codex, the flags before this change | `AGENTS.md`, both skills, and the skill bodies on `$name` (no project config: untrusted, as above) |
| Codex, `skills.include_instructions=false` alone | No catalog, but a `$name` mention still loaded the skill body |
| Codex, the first version's arguments (`6bd5cf9`: worktree skills disabled by a scan), a skill added after the scan (the review's repro) | **The skill body was sent** on `$late`. A per-invocation scan cannot isolate the worktree |
| Codex, a path-linked mention `[$x](<path>/SKILL.md)` from the worktree | Loads the skill at that path whatever name the link uses, but only a discovered one: a `SKILL.md` outside any skill root never loads |
| Codex, working root in an empty folder, worktree as `--add-dir` or as `sandbox_workspace_write.writable_roots`, with `--skip-git-repo-check` and `project_root_markers=[]` | Nothing from the worktree, under every mention form. The worktree is listed to the model as a workspace and writable root. The same with the working root nested inside the worktree (no parent search) |
| Codex, this version's exact arguments, working root and prompt (built by the adapter; model provider swapped for the capture endpoint), late skills added after the adapter ran, the prompt naming `$late`, `$late2`, a link to the late `SKILL.md`, two of the operator's own skills and `$imagegen`; fresh, then resumed from a second working root | **No canary from the worktree and no skill of any kind.** The one canary left is the operator's global `$CODEX_HOME/AGENTS.md` (open question 2) |
| Codex, the operator's own skills and `$imagegen` without this version's flags | All three skill bodies were sent on mention |
| Codex, a session started with the isolation and resumed without it | Skills and `AGENTS.md` came back, so the flags are needed on `exec resume` too (they are passed) |
| Codex, a git worktree of a trusted repository, without `--ignore-user-config` | The worktree inherited the repository's trust and `developer_instructions` loaded; an explicit `untrusted` entry for the worktree path stopped it |
| Claude Code, no flags | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, both hook outputs, all hook markers and the MCP marker |
| Claude Code, the adapter's exact arguments, fresh and `--resume` | **No canary and no marker**; the session reported `slash_commands: []`, `skills: []`, `mcp_servers: []` |

`codex debug prompt-input` (renders the model-visible input, no model call) agreed for the catalog and project configuration, but it does not resolve `$name` mentions, so the capture endpoint is the stronger check. The live checklist ([provider instruction loading](../qualification/provider-instructions.md)) is updated with this version's flags, the late-skill and linked-mention canaries and this offline method. Its paid steps have not been run for this version; the earlier, project-documents-only version passed live in the dev.89 re-test.

### What isolation does not cover: reading files with tools

Isolation is about **loading**: no CLI puts the worktree's `AGENTS.md`, `CLAUDE.md`, `.codex/`, `.agents/` or `.claude/` content into a model's context on its own. It does not stop a model from **reading** those files with its tools. They are files in the repository it works on, and to a builder they are data like any other.

- A Codex step keeps its shell tool even in the read-only sandbox. In the dev.90 re-test a Codex builder read `AGENTS.md` and a governing file with `cat` as its first command. The live checklist step, as then written, made the model read the planted skills with `rg` and `cat` (see [the checklist](../qualification/provider-instructions.md)).
- A Claude Code builder reads files with Read, Glob and Grep, and planners and reviewers have those tools too.

A file read this way is not delivered as instructions, but a model may follow what it reads. That matters most where the worktree may hold a proposed governing file: a governance edit or a knowledge-upkeep context task. There the package's `Governing context` block carries the files as they are at the comparison commit, and the worktree's version is the change under review. The live checklist forbids reading so that its answer reflects loading only; the offline capture is the evidence for loading.

## A candidate never carries undeclared provider configuration

As a second line, independent of any CLI's discovery rules: `operations/provider-config.mjs`.

- **The boundary.** A candidate may add, change or remove provider configuration only when its task declares it. Provider configuration is any path with a component `.codex`, `.agents` or `.claude`, or ending in `.mcp.json`, at any depth and in any letter case, including a link with such a name.
- **Declared means named.** A path in the task's `paths` must be the changed path or a folder above it, and must itself be provider configuration. `.claude` or `.claude/skills/report` declares; `.` or `src` does not.
- **Links count (after the review).** A link at a provider-configuration path, in the comparison commit or the candidate, makes what it reaches provider configuration too, named through the link.
  - **How links are read.** Each link is resolved through verified trees, with the same resolution the governing-file boundary uses (`core/tree-paths.mjs`).
  - **Links behind links (after the re-check).** A folder a provider-configuration link reaches is walked under the link's alias, and every link inside it is followed in turn, keeping the alias. With `.agents -> shared` and `shared/skills/report -> ../../docs/report`, `docs/report/SKILL.md` is reached as `.agents/skills/report/SKILL.md` and needs that declared. A path reached under several aliases must be declared under each.
  - **Cycles are refused (after the second re-check).** A link reachable under a provider-configuration path that leads back to a folder already on the way to it is a cycle. Examples are a link to the repository root, or `shared/skills/loop -> ..` behind `.agents -> shared`.
    - A cycle in the comparison commit or in the candidate refuses the candidate outright, whatever is declared.
    - The refusal names the link, the path a provider reaches it by and where it leads, and asks for the link to be removed.
    - What a provider loads through a cycle has no end of names, and the cycle also reaches out through every other link on the way. So no declaration can be shown to cover it, and skill layouts never need one.
  - **Bounds.** More than 40 links in a row (`MAX_LINK_HOPS`), or more than 50 000 entries behind links in one commit, refuses the candidate: its reach cannot be shown. The refusal names the bound; remove or shorten the links.
  - **Example.** With `.agents/skills/report -> ../../docs/report`, a change to `docs/report/SKILL.md` is refused unless the task declares `.agents/skills/report` (or `.agents`). Declaring `docs/report` is not enough. The refusal names the file and the link.
  - **Links to the root, and links that leave the repository.** A link to the repository root makes every change reachable through it. A link that leaves the repository reaches nothing in any candidate; its own changes are checked like any other path.
  - **Why resolve instead of reject.** Rejecting every configuration folder that holds a link was the simpler choice. It would refuse every task in a repository that shares skills between agents with a link, such as `.claude/skills -> ../.agents/skills`, a common layout.
- **Where it is checked.** It runs inside `assertGoverningBoundary`, so at the same five points as the governing-file boundary: before review, `workspace.commit` (undone on refusal, the change left uncommitted), `workspace.integrate`, `forge.publish` and `forge.merge`. A refused builder change never reaches a reviewer, a later build or the target.
- **How it is read.** Trees are compared through hash-verified objects, level by level in batches, descending only into subtrees whose IDs differ. Finding the links reads every tree of both commits, in one batch per level. The cost grows with the repository's folder count and is paid at each of the five points. Within one check, both walks share one verified-object cache.
- **Governing files.** A governing file in such a folder still needs the governing-file approval; the declaration never widens it.

This is right as defence in depth. The working root already keeps every Codex step from discovering these folders, and Claude Code loads none of them. The boundary keeps that true if a CLI upgrade adds a discovery route. It also stops a builder's planted configuration from reaching the target, where an operator's own CLI or a later flow could load it. Declaring the paths keeps a task that is meant to change them possible.

## What was built

| Piece | Where |
| --- | --- |
| The isolation flags for every invocation, Codex's empty working root and the prompt's `Repository:` notice, the scan of the operator's skill folders, the untrusted projects, the fail-closed argument and preflight checks | `starter/factory/adapters/providers/index.mjs` |
| The provider-configuration boundary, links included | `starter/factory/operations/provider-config.mjs` (new), called from `assertGoverningBoundary` in `starter/factory/operations/governance-edit.mjs` |
| Docs | this record, `docs/runtime-followups.md`, `docs/qualification/provider-instructions.md`, `docs/qualification.md`, `docs/project-workflows.md`, `docs/changes/governance-edit-context.md` |

## Compatibility

- **Unchanged:**
  - reference graphs and their digests;
  - the task schema, briefs, revisions and the prompts the factory records (Codex's input gains the `Repository:` notice ahead of it);
  - no SQL reads over `records.data` were added.
- **Every Codex step:**
  - runs from an empty working root in the step's artifact folder, and works in the worktree by its path;
  - reads no `AGENTS.md`;
  - loads no repository skill, hook or project configuration;
  - loads no skill of the operator's own or bundled with Codex.
- **Every Claude Code step:**
  - has no skills or commands, built-in ones included.
- **An artifact folder inside the worktree** refuses the Codex step. The factory's artifact folders are in the state directory, which must be outside project checkouts.
- **Preflight** now needs `--disable` and `--skip-git-repo-check` in `codex exec --help`, and `--disable-slash-commands` in `claude --help`. Both exist in Codex 0.169.0 and Claude Code 2.1.325. An older CLI fails preflight before any model starts.
- **Candidates:**
  - a candidate that changes provider configuration its task does not declare, or something a link there reaches, is refused before review and in commit, integration, publication and merge;
  - an adopted pull request that does so is refused at integration.

## Release notes

- **Every model step starts its provider isolated from the worktree.**
  - **Codex** runs from a fresh, empty working root outside the worktree, for every task, fresh and resumed. It works in the worktree by its path: the worktree is its writable root, and the prompt starts with `Repository: <worktree>`. So nothing in the worktree is discovered as skills, `AGENTS.md` or project configuration, whenever it was written.
  - **Codex flags:**
    - `--disable hooks`;
    - `--disable plugins` (since dev.106);
    - `--skip-git-repo-check`;
    - `project_doc_max_bytes=0`;
    - `skills.include_instructions=false`;
    - `skills.bundled.enabled=false`;
    - `project_root_markers=[]`;
    - the working root, the worktree and every folder above them explicitly untrusted.
  - **Claude Code** also gets `--disable-slash-commands`.
  - **The effect.** A builder can no longer leave `.codex/`, `.agents/` or `.claude/` content that a later step loads as instructions. The adapter refuses to start a provider without its isolation.
- **Breaking: Codex no longer reads `AGENTS.md` or repository skills for any task.**
  - Before, it read `AGENTS.md` for every task except approved governance edits, and listed `.agents/skills/` and `.codex/skills/`.
  - Claude Code steps already ran without `CLAUDE.md` and project skills.
- **Breaking: no skill of the operator's own in factory steps.** Codex steps no longer load the operator's skills (`$CODEX_HOME/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`) or Codex's bundled ones (such as `imagegen`). Claude Code steps already ran in safe mode. There is no allowlist.
- **Behaviour change: Codex's working directory.** A Codex step's current directory is an empty folder, not the repository. The model is told the repository's path, and Codex lists it as a workspace root, but a model that ignores that and writes relative to its current directory writes into the empty folder. Its change is then missing from the candidate, and checks or review send the build back.
- **Breaking: provider configuration in a candidate must be declared.**
  - A candidate that adds, changes or removes anything under `.codex/`, `.agents/` or `.claude/`, or a `.mcp.json`, is refused unless the task's `paths` name it.
  - So is a change to anything a link in those folders reaches, named through the link.
  - The refusal comes before review and in commit, integration, publication and merge.
  - For example, list `.claude/skills/report` or `.agents` in `paths`; `.` does not count.
- **Breaking: older CLIs.** Preflight needs `codex exec --help` to list `--disable` and `--skip-git-repo-check`, and `claude --help` to list `--disable-slash-commands`.

**What adopters do**

- **If your project's root `AGENTS.md` (or another instruction file) carries rules your factory steps must follow:** add it to `context.files` (for example `{"id": "project-agents", "path": "AGENTS.md", "required": true}`) and run `config update` with no change flow running. The factory then delivers it to every provider.
- **If Codex steps relied on repository skills, or on your own or bundled skills:** put what they need in a governing context file instead. The `use-factotum` and `factotum-workflows` skills in `project/skills/` are for the operator's own agent, not for factory steps, and are unaffected.
- **If a task is meant to change provider configuration** (for example adding a skill for the operator's agent): list the exact path or folder in the task's `paths`, as the provider reaches it (through a link, the link's path). A running task whose candidate already touches such a path stops before its next review: undo the change, or stop the flow and put the task again with the path declared.
- **On a host whose CLIs are older than Codex 0.169.0 or Claude Code 2.1.325:** upgrade them, then run `doctor`.
- **Keep the state directory outside every project checkout** (as [running](../running.md) requires): a Codex step whose artifact folder is inside its worktree is refused.
- **If a Codex step fails with a refusal about your skill folders** (too deep, too many entries or skills, unreadable): fix the folder it names, then run `task.restart` for the task.
- **If `upkeep.context.qualifiedProviders` lists `codex`:** run this version's checklist before relying on it.
- **Before relying on governance edits, and after a provider CLI upgrade:** run the [provider instruction-loading checklist](../qualification/provider-instructions.md). Its offline part needs no model call.

## Tests

`tests/provider-worktree-isolation.test.mjs` (new; fictional transports and Git fixtures, no provider CLI started). The last column is where each test fails on `6bd5cf9`, the first version, for the tests added or rewritten after its review.

| Test | What it shows | On `6bd5cf9` |
| --- | --- | --- |
| `every Codex step, fresh and resumed, runs from an empty working root outside the worktree, so nothing in the worktree is discovered, even what appears after the factory looked` | The review's repro as a test. The transport adds a skill to the worktree only when the CLI is launched, and then applies Codex 0.169.0's discovery rules (as the capture showed them) to the working root and arguments it was given: nothing is discovered. Also: the static flags, a fresh private working root in the artifact folder, the worktree as writable root and named ahead of the prompt, the untrusted folders and the subscription environment, for an ordinary builder, a governance-edit step and a read-only step | fails at the first assertion: the late skill is discovered |
| `the operator's own Codex skills are disabled too, bundled ones by configuration` | Skills in `$CODEX_HOME/skills` (and the default `$HOME/.codex/skills`), `$HOME/.agents/skills` and a bundled `.system` skill disabled; `skills.bundled.enabled=false` | fails: the operator's skill is not disabled |
| `every Claude Code step, fresh and resumed, starts in safe mode with no settings, no skills or commands and no MCP servers` | The Claude flags and environment, fresh and `--resume` | passes (unchanged) |
| `the operator's skill folders are read within bounds, a folder's entries one at a time, each distinct skill counted once` | Depth, more than 4096 entries in one folder, an unlistable folder; 256 skills each with a link to it accepted, the 257th distinct skill refused | fails at its first refusal (the first version read no operator folder; its repository scan had no per-folder bound and counted a skill and its link twice) |
| `a CLI without the isolation options, an artifact folder in the worktree and an unusable path refuse the step before any model starts` | Preflight without `--disable`, `--skip-git-repo-check` or `--disable-slash-commands`; an artifact folder inside the worktree; a missing working directory; a newline in the path; TOML escaping; `assertWorktreeIsolation` refusing incomplete arguments and a working root inside the worktree | fails at the missing `--skip-git-repo-check` |
| `which paths are provider configuration, and which declared paths cover them` | The path rule and the declaration rule | passes |
| `commit, integration, publication and merge refuse provider configuration the task does not declare` | A planted `.codex/skills/canary/SKILL.md` refused at all four, the commit undone, nothing published | passes |
| `declared provider configuration is delivered; anything else in those folders, a removal, a link and a nested folder are refused` | A declared skill folder commits; a sibling, settings, a removed skill, `.mcp.json`, `src/.Codex/`, and a link named `.codex` are refused | passes |
| `a change reached through a provider-configuration link must be declared as the provider reaches it` | The review's P2 repro: with `.agents/skills/report -> ../../docs/report`, a change to `docs/report/SKILL.md` declared as `docs/report` (or under `.`) is refused through the link, and accepted declared as `.agents/skills/report`. A link to the repository root added by the candidate is a cycle, refused whatever is declared. A link to a folder added by the candidate is covered by declaring `.claude`. A link outside the repository reaches nothing | fails at the first refusal: the change is accepted |
| `links behind a provider-configuration link are followed under its alias` (re-check) | The re-check's repro (`.agents -> shared`, `shared/skills/report -> ../../docs/report`) refused under `docs/report`, accepted once `.agents/skills/report` is declared; the reach rows | fails at the first refusal on `8c2b6d7` |
| `a link cycle under provider configuration refuses the candidate, in the comparison commit or the candidate, naming the link` (second re-check) | The second re-check's repro: `shared/skills/loop -> ..` in the comparison commit is refused under `.agents/skills/report` and under `.agents`. Added by the candidate, it is refused the same way. Once removed, the change goes through. The reach throws `providerLinkCycle` naming the link | fails at the first refusal on `f4d100c`: the change is accepted |
| `a chain of links through provider configuration longer than the bound refuses the candidate` (re-check) | 41 links in a row from `.claude/` refuse the candidate | fails on `8c2b6d7`: accepted |
| `the changed provider-configuration paths are read from verified trees, level by level` | A file replaced by a folder lists both sides' leaves; 30 nested skills in an added folder are found in at most 10 batched reads | passes |

`tests/governance-edit-context.test.mjs`:
- **New test:** `a builder that commits provider configuration the task does not declare is stopped before review sees it`. It runs engine prepare and settle; no reviewer starts.
- **Changed assertion:** the Q1 test's last assertion now checks that an ordinary step also gets `project_doc_max_bytes=0`. It asserted the opposite before this change.

**Fixture changes.**
- The fake `--help` text in six test files gained `--disable`, `--skip-git-repo-check` and `--disable-slash-commands`.
- Fixtures that put the artifact folder inside the provider's working directory now use a `work` subfolder beside it. These are in `tests/providers.test.mjs`, `tests/provider-limits.test.mjs`, `tests/protocol-recordings.test.mjs` and `tests/governance-edit-context.test.mjs`.
- Two assertions in `tests/providers.test.mjs` now expect the Codex input to start with the `Repository:` notice.

## Review of `6bd5cf9`

An independent review (GPT-6.1 Sol) requested changes: one P1 and one P2. These held up:
- the boundary on every path;
- case-insensitive matching;
- explicit declared paths;
- TOML escaping;
- the migration note.

1. **P1: a skill added after the scan still loaded.** The reviewer reproduced it with Codex 0.169.0 and a refusing local endpoint: compute the isolation with no skills present, add `.agents/skills/late/SKILL.md`, launch with `Use $late`. The skill body was sent; retargeting a link does the same. A scan at each invocation cannot establish isolation.
   - **Fixed** by running Codex from an empty working root outside the worktree (see [The flags](#the-flags)), after finding no option that turns repository skill discovery off.
   - **Confirmed** with the reviewer's repro through the offline capture, fresh and resumed, under every mention form.
   - **Also a test**, which fails on `6bd5cf9` at the discovery of the late skill.
   - The repository skill scan is removed.
2. **P2: an existing link got around the delivery boundary.** `.agents/skills/report -> ../../docs/report`, and a change to only `docs/report/SKILL.md`, with `docs/report` declared, was accepted. **Fixed** by resolving links at provider-configuration paths through verified trees, with what they reach named through the link (see [above](#a-candidate-never-carries-undeclared-provider-configuration)). Rejecting folders that hold links would have broken shared-skill layouts.
3. **Resource bounds.**
   - **The scan's scope.** It now reads only the operator's folders, never a candidate's.
   - **The new bounds.** Each folder's entries are read one at a time, at most 4096 per folder. Skills are counted by real path, at most 256.
   - **Recovery.** Stated under [Failing closed](#the-flags). A candidate cannot trigger these refusals.
4. **The operator's own skills** are disabled for factory steps too, by decision. An allowlist would be inert without the catalog, so none is offered (see [The flags](#the-flags)).

## Re-check of `8c2b6d7`

The re-check (GPT-6.1 Sol) found one P2 still open. These held:
- the offline capture, fresh and resumed, against late, retargeted, linked and operator skills;
- the sandbox (reads and writes, read-only mode, Git and tests with an explicit working directory);
- writable scope and lifecycle;
- Claude Code's global surfaces;
- tests, docs and digests.

1. **P2: nested links got past the boundary.** Links were collected only where their own path held a provider-configuration component. With `.agents -> shared`, `shared/skills/report -> ../../docs/report` and only `docs/report/SKILL.md` changed under `paths: ["docs/report"]`, the change was accepted, though the provider reaches it as `.agents/skills/report/SKILL.md`. **Fixed** by following linked folders under their aliases, with cycle and depth bounds, in both trees (see [above](#a-candidate-never-carries-undeclared-provider-configuration)).
   - **Tests:** `links behind a provider-configuration link are followed under its alias, and a link cycle ends` (the repro and a cycle to the repository root) and `a chain of links through provider configuration longer than the bound refuses the candidate`. On `8c2b6d7` both fail at their first refusal: the change is accepted.
2. **Documentation.**
   - **Runtime follow-up:** [Containment of builder and check processes](../runtime-followups.md#containment-of-builder-and-check-processes-p2), rated P2. It covers the operator's home (`$CODEX_HOME/AGENTS.md` among it), credentials and factory state, which unsandboxed builder and check processes can write.
   - **Change record:** the model's behaviour with the empty working root is now an item to watch in the first live Codex builds (open question 3).

## Second re-check of `f4d100c`

The second re-check (GPT-6.1 Sol) found one P2. The nested repro and its variants passed, and so did the shared layout `.claude/skills -> ../.agents/skills` with both paths declared.

1. **P2: cycle handling missed reach through outgoing links.** With `.agents -> shared`, `shared/skills/report -> ../../docs/report` and `shared/skills/loop -> ..`, a change to `docs/report/SKILL.md` declared as `.agents/skills/report` was accepted. A provider can also read it as `.agents/skills/loop/skills/report/SKILL.md`.
   - **Fixed simply**, as asked: a cycle anywhere reachable under a provider-configuration path, in either commit, refuses the candidate. The refusal names the link and asks for its removal.
   - **Removed:** the cycle-coverage logic (record once, declare at the cycle's alias).
   - **Tests:** the repro is a new test. The link-to-root case in the earlier test now expects a refusal. Both fail on `f4d100c`.

## Results

On this branch: `cc6807c`, the two review rounds, and `main` at `b5f3d84` merged in.

- `node --test tests/provider-worktree-isolation.test.mjs`: 13 of 13 pass.
  - On `6bd5cf9` (exported with `git archive`, the test file of that round copied in), 5 of 10 failed, as the table says.
  - On `8c2b6d7`, the two re-check tests fail at their first refusal.
  - On `f4d100c`, the cycle test and the adjusted link-to-root test fail at their first refusal.
- Full `npm test`: 1715 tests, 1714 passed, 0 failed or cancelled, 1 skipped. The skip is the existing confusables source test, which needs `FACTOTUM_CONFUSABLES_TXT`.
- `npm run eval`: exit 0.
- `git diff --check cc6807c..HEAD`: clean.

## Open questions

1. **The paid live steps** of this version of the [provider instruction-loading checklist](../qualification/provider-instructions.md) have not been run. The earlier, project-documents-only version passed live in the dev.89 re-test. The offline capture exercised the real CLIs' request path, fresh and resumed, but not a model's behaviour.
2. **`$CODEX_HOME/AGENTS.md`**, the operator's global Codex instructions, is still loaded by every Codex step (now tracked as the runtime follow-up [Containment of builder and check processes](../runtime-followups.md#containment-of-builder-and-check-processes-p2)). It loads even with `--ignore-user-config` and `project_doc_max_bytes=0`, and no Codex 0.169.0 option turns it off. It is the operator's file, not the worktree's, but a process outside the worktree can write it. For example, a Claude Code builder's Bash, which is not sandboxed, could write it, and every later Codex step would read it. The same holds for anything else in the operator's home. Isolating that needs a separate `CODEX_HOME` with the login in it, or an operating-system sandbox around builders. Both are decisions beyond this change.
3. **Watch the model's behaviour with the empty working root in the first live Codex builds.**
   - **Why.** The model is told the repository's path, and Codex lists it as a workspace and writable root. The re-check confirmed that the sandbox allows reads and writes there, and that Git and tests work with an explicit working directory. But no model has run this way: the capture shows what is sent, not how a model acts on it.
   - **What to look for.** Changes written to the working root instead of the worktree show up as a build with no change. Also look for commands run in the wrong directory, and for more turns than before.
   - **If the first builds go badly.** The prompt's notice is the place to strengthen first.
4. **Codex's discovery rules** are partly undocumented: `.codex/skills/` is read by Codex 0.169.0 but not on the skills page. The working root makes the worktree's folders irrelevant, whatever their names. A later Codex that discovers skills in its writable roots as well would undo that; the checklist's late-skill step is the check after an upgrade.
