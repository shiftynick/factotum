# dev.106: the operator's Codex skill folders are scanned the way Codex discovers skills

Fixes a blocking report from the third adopter on dev.105. Base: `main` at `b3c7586`.

## The report

Since dev.90 ([provider worktree isolation](provider-worktree-isolation.md)), every Codex step disables each skill in the operator's skill folders by path. To find them, the adapter walked `$CODEX_HOME/skills`, `$HOME/.agents/skills` and `/etc/codex/skills`. It refused to start Codex past fixed bounds: depth 8, 2,000 folders, 4,096 entries in one folder and 256 skills. An unwalked folder might hold a skill that Codex would load.

On the third adopter's host, `$CODEX_HOME/skills/ui-craft` is a link to a skill folder elsewhere. That skill bundles its dependencies in `scripts/node_modules` (Playwright and similar). The walk passed depth 8 inside `node_modules` and refused. So every Codex step refused, in every project on that host, and the adopter's first task stopped at plan review.

The refusal was right in principle, but its bounds were the factory's own guesses, not Codex's. Codex never reads that deep.

## How Codex discovers skills

This was read from Codex's public source at each release tag (`github.com/openai/codex`, tags `rust-v<version>`). Line numbers are for `rust-v0.171.0`, the installed version (`codex --version`: `codex-cli 0.171.0`). No model session was started. `codex --help` and `codex exec --help` say nothing about skill discovery. They say only that `--ignore-user-config` still "uses `CODEX_HOME`" for auth.

**The skill folders.** `ext/skills/src/host_roots.rs:150-179` lists the user layer's folders: `$CODEX_HOME/skills`, `$HOME/.agents/skills` and the bundled skills' cache `$CODEX_HOME/skills/.system`. The system layer adds `/etc/codex/skills`.
- `HOME` comes from `dirs::home_dir()` (`host_roots.rs:70-71`). That is `$HOME`, or the account's home folder when `HOME` is unset or empty.
- An empty `CODEX_HOME` counts as unset (`utils/home-dir/src/lib.rs:13-17`).
- With `skills.bundled.enabled=false`, the bundled skills' folder is dropped (`ext/skills/src/host_service.rs:307-308` and `351-352`).

**One walk per folder.** Each skill folder is walked separately, from its real path (`ext/skills/src/loader/host.rs:133`). The walk is `sync_walk` in `exec-server/src/local_file_system.rs:740-897`:

| Question | Answer | Source |
|---|---|---|
| Order | Breadth first (a queue), each folder's names sorted | `local_file_system.rs:776`, `782`, `799` |
| Depth limit | `MAX_SCAN_DEPTH = 6`. The skill folder is depth 0; folders at depth 0 to 6 are read, and a folder is queued only from a depth below 6. So a `SKILL.md` at most seven path parts below the skill folder is found, and nothing deeper is read | `ext/skills/src/loader/mod.rs:26`, `discovery.rs:71-72`, `local_file_system.rs:860` |
| Folder links | Followed for the operator's and administrator's folders (`SkillScope::User`, `Admin`). A folder already visited in this walk, by real path, is not queued again | `host.rs:161-164`, `local_file_system.rs:864-885` |
| Links to files | Skipped: a link counts only when it leads to a folder | `local_file_system.rs:837-839` |
| Broken links | Left out of the listing, so not counted | `local_file_system.rs:1131-1136` |
| Hidden folders | Not entered: a folder whose name starts with `.` is listed but never queued, and an entry with a hidden folder above it is dropped | `host.rs:176`, `local_file_system.rs:861-863`, `discovery.rs:120-128` |
| Dependency folders such as `node_modules` | Not special: walked like any other folder, within the depth limit | (no such rule in `discovery.rs` or `sync_walk`) |
| Below a found skill | Codex keeps going: the walk gathers every entry first, and every `SKILL.md` it reached is a skill, so a skill inside another skill's folder is a skill too | `discovery.rs:125-162` |
| The skill file | A regular file named exactly `SKILL.md` | `loader/mod.rs:21`, `discovery.rs:149` |
| Caps | At most 2,000 folders queued per walk, the skill folder included, and 20,000 entries looked at. Past a cap, the walk stops and Codex still loads the skills it found, with a logged warning | `loader/mod.rs:27`, `discovery.rs:17`, `75-76`, `103-118`, `local_file_system.rs:778`, `803-807`, `886-891` |

**Disabling.** A `skills.config` entry selects a skill either by `name` or by `path`.
- A `path` is canonicalized when it is read (`config/src/skills_config.rs:197-200`). It must equal the skill's canonical `SKILL.md` path (`skills_config.rs:79-84`, `103-134`), which is also canonicalized (`host.rs:202`).
- So one skill is disabled by its real path. A folder cannot be disabled; dev.90's capture found the same.
- A `name` selector disables every skill with that name, which the factory does not use.

**Versions.** Every stable tag from `rust-v0.163.0` to `rust-v0.171.0` agrees on every rule above: 0.163.0, 0.164.0, 0.165.0, 0.166.0, 0.167.0, 0.167.1, 0.167.2, 0.168.0, 0.169.0, 0.169.1, 0.170.0 and 0.171.0. This was checked by comparing the constants, the walk options, the scope policies, the root list, the path canonicalization and the `sync_walk` lines that decide order, depth, links, hidden folders, the visited set and the caps. Across those tags, `discovery.rs` and `host_roots.rs` changed only in error reporting and plumbing. 0.163.0 is the oldest Codex the factory has recorded.

## What changed

`adapters/providers/index.mjs`: `CODEX_SKILL_DISCOVERY`, `codexSkillRules`, `operatorSkillFolders`, `codexOperatorSkills`, `codexSkillWalk`.

**The adapter scans the skill folders under the rules of the Codex version that preflight reported.**

- **A checked version (0.163.0 to 0.171.0) follows Codex's own discovery:**
  - each skill folder is its own breadth-first walk, with its own record of visited folders;
  - folders deeper than depth 6 are not read, and hidden folders are not entered;
  - nothing is refused for depth.
- **The factory never reads less than Codex.** It may read more, and it never stops before Codex would:
  - **Whole levels.** It reads every folder of a level that Codex might reach, so it does not depend on Codex's order within a level.
  - **When it stops.** It queues no folder for the next level once Codex has queued 2,000, and reads no further level once Codex has looked at 20,000 entries. Codex reads nothing past either point.
  - **What it counts.** Only what Codex counts: an entry that can be looked at, and a folder Codex would queue. Its counts are therefore never higher than Codex's.
  - **What it disables.** Any letter case of `SKILL.md`, and links to files, in every folder it reads. Each skill is disabled by the spelling it was reached by and by its real path, as before.
- **The factory's own bounds**, which still refuse:
  - more than 100,000 entries read in one skill folder. Every folder read is an entry of the folder above it, so this bounds folders too. Codex's caps keep a normal folder far below it;
  - more than 256 distinct skills;
  - a folder in Codex's reach that cannot be listed;
  - a path that cannot be resolved.
- **Any other Codex version keeps the dev.90 scan unchanged.** That scan reads every folder (hidden ones included), refuses past depth 8, 2,000 folders, 4,096 entries in one folder or 256 skills, and refuses an unreadable folder. Its refusal now starts by saying that this Codex version's discovery has not been checked, and names the checked range.
- **`HOME` unset.** The operator's folders are found as Codex finds them: with `HOME` unset or empty, the account's home folder is used. Before, `$HOME/.agents/skills` and the default `CODEX_HOME` were skipped in that case.

For the reported layout this means:
- `$CODEX_HOME/skills/ui-craft/SKILL.md` and its real path are disabled;
- a `SKILL.md` within six levels, such as `scripts/node_modules/@scope/kit/SKILL.md`, is disabled too;
- the rest of `node_modules`, below depth 6, is not read, and Codex starts.

**Doctor warns ahead of time** (`workflows/commission.mjs`).
- For each Codex version its probes report, doctor runs the same scan on this host's skill folders, with the environment a provider gets. New progress phase: `codex skill folder check`.
- When the scan would refuse, doctor adds a warning. It never blocks commissioning. The warning says that every Codex step on this host will be refused before it starts, and quotes the refusal, which names the folder and the bound. It then gives the remedy:
  - **an unchecked Codex version:** install a checked one, or remove the cause from the folder named;
  - **otherwise:** move a large dependency tree out of the operator's skill folders, remove the extra skills, or make the folder readable.

## The alternative: a separate `CODEX_HOME`

Starting Codex with its own `CODEX_HOME`, holding only the login and the factory's settings, would put the operator's `$CODEX_HOME/skills` and `$CODEX_HOME/AGENTS.md` out of reach. It was not chosen:

- **Credentials.** Codex saves `auth.json` by writing a new file and renaming it over the old one (`login/src/auth/storage.rs:274-292`).
  - **A link.** An `auth.json` linked into a separate home would be replaced by a copy at the first token refresh.
  - **A copy.** Copying the file has the same effect.
  - **Either way** the refresh token forks, which can sign the operator out (dev.90 found the same risk).
- **Not every skill folder lives there.** `$HOME/.agents/skills` and `/etc/codex/skills` are outside `CODEX_HOME`, so the scan would still be needed.
- **Resuming.** `codex exec resume` reads the session's record from `$CODEX_HOME/sessions` (`rollout/src/lib.rs:88`). A separate home would have to keep those records, or resumed builds would break.

So the smaller fix is the safe one now. A separate `CODEX_HOME`, which would also close the `$CODEX_HOME/AGENTS.md` gap, stays a [runtime follow-up](../runtime-followups.md#codex-a-separate-codex_home-for-factory-steps-dev106).

## Tests

`tests/dev106-codex-skill-discovery.test.mjs`, with fictional fixtures and a scripted transport (no CLI or model is started). The test transcribes Codex's discovery (`codexFinds`, from `sync_walk` and `discover_skills` as cited above), and every fixture asserts that each skill it finds is disabled.
- **The reported layout.** A skill linked into `$CODEX_HOME/skills`, with a `scripts/node_modules` tree twelve levels deep, 40 packages, a hidden `.bin` and a `SKILL.md` inside `node_modules` within reach. Under 0.171.0, 0.169.0 and 0.163.0, Codex starts. The skill is disabled by the link's spelling and by its real path, and the reachable `SKILL.md` is disabled. One below depth 6 is not listed. Under 0.172.0 the step is refused with the unchecked-version message.
- **Nesting and links.** A skill inside another skill is disabled, and so is one at depth 6. One at depth 7 is disabled when a folder link reaches it at depth 2. A folder too deep in `$CODEX_HOME/skills` is disabled when `$HOME/.agents/skills` reaches it through a link, because each skill folder is its own walk. A hidden folder's skill is not listed.
- **Codex's caps.** With 2,000 folders at depth 1, a skill in the last one (which Codex never reads) is still disabled, and nothing below that level is read; with fewer folders, the next level is read. With 20,000 entries at depth 1, the rest of that level is read and the next level is not.
- **The bounds still refuse.** More than 100,000 entries in one level Codex may read, more than 256 skills, and an unreadable folder in reach. The same unreadable folder below depth 6 refuses nothing.
- **Doctor.** No warning for the reported layout under 0.171.0. Under 0.172.0, a warning naming the folder and the remedy. Under 0.171.0, a warning for more than 256 skills. No check without a Codex route.
- **Rules by version,** and the skill folders for an environment, including `HOME` unset and `CODEX_HOME` empty.

`tests/provider-worktree-isolation.test.mjs`:
- the depth and per-folder entry bounds are now tested on the conservative scan;
- the unreadable folder is refused under both scans;
- `skills/.system/imagegen` is no longer expected in the disabled list (Codex never enters it, and `skills.bundled.enabled=false` drops its folder);
- a link's own spelling is listed.

## What an adopter does

Nothing on a checked Codex version: Codex steps that the scan refused now start. Run `doctor` after upgrading.
- **A Codex newer than 0.171.0** is scanned as before dev.106, and doctor says so. Either stay on a checked version until a factory release checks the new one, or keep large dependency trees out of the operator's skill folders.
